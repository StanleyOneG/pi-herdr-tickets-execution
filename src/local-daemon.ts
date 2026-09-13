import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { spawn } from "node:child_process";

import type {
  AdmissionSnapshot,
  AnswerDecisionRequest,
  ApprovalRequest,
  AttemptRequest,
  BatchProposal,
  ControllerResult,
  ControllerStatus,
  ExecutionAttempt,
  PaginationRequest,
  PreparationRecord,
  WorkerIdentity,
  PrepareRequest,
  RecordWorkerObservationRequest,
} from "./contracts.js";
import { PreparationController } from "./controller.js";
import type { WorkerDecisionRequest } from "./worker-bridge-protocol.js";

const MAX_IPC_BYTES = 6 * 1024 * 1024;
const DAEMON_BIN_PATH = fileURLToPath(new URL("../bin/herdr-controller.mjs", import.meta.url));

export interface WorkerDecisionMonitor {
  nextDecision(identity: WorkerIdentity): Promise<WorkerDecisionRequest | undefined>;
  acknowledgeDecision(identity: WorkerIdentity, decisionId: string): Promise<void>;
}

export interface LocalDaemonPaths {
  runtimeDirectory: string;
  socketPath: string;
  tokenPath: string;
  workerBridgeDirectory: string;
}

export interface ControllerClient {
  prepare(request: PrepareRequest, snapshot: AdmissionSnapshot): Promise<ControllerResult<PreparationRecord>>;
  submitProposal(preparationId: string, proposal: BatchProposal): Promise<ControllerResult<PreparationRecord>>;
  approve(preparationId: string, request: ApprovalRequest): Promise<ControllerResult<PreparationRecord>>;
  preview(preparationId: string): Promise<ControllerResult<string>>;
  getPreparation(preparationId: string): Promise<ControllerResult<PreparationRecord>>;
  validateApproval(preparationId: string, request: ApprovalRequest): Promise<ControllerResult<PreparationRecord>>;
  startTicket(request: import("./contracts.js").StartTicketRequest): Promise<ControllerResult<ExecutionAttempt>>;
  attachAttempt(request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>>;
  pauseAttempt(request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>>;
  resumeAttempt(request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>>;
  takeOverAttempt(request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>>;
  returnAttempt(request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>>;
  answerDecision(request: AnswerDecisionRequest): Promise<ControllerResult<ExecutionAttempt>>;
  recordWorkerObservation(request: RecordWorkerObservationRequest): Promise<ControllerResult<ExecutionAttempt>>;
  status(pagination: PaginationRequest): Promise<ControllerResult<ControllerStatus>>;
}

type RequestMethod = keyof ControllerClient | "ping";
interface IpcRequest { id: string; token: string; method: RequestMethod; params: unknown[] }
type IpcResponse = { id: string; ok: true; value: unknown } | { id: string; ok: false; error: string };

/** Private Unix-socket server. It is the only holder of the controller actor capability. */
export class LocalControllerDaemon {
  private server: Server | undefined;
  private monitorTimer: NodeJS.Timeout | undefined;
  private monitoring = false;
  private readonly ownershipId = randomBytes(16).toString("base64url");
  private ownershipHeld = false;

  constructor(
    private readonly controller: PreparationController,
    private readonly actor: symbol,
    private readonly socketPath: string,
    private readonly token: string,
    private readonly decisionMonitor?: WorkerDecisionMonitor,
  ) {}

  async start(options: { markRestarted?: boolean } = {}): Promise<void> {
    if (this.server) throw new Error("Local controller daemon is already started");
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.socketPath), 0o700);
    await this.acquireOwnership();
    try {
      await removeStaleSocket(this.socketPath);
    } catch (error) {
      await this.releaseOwnership();
      throw error;
    }
    if (options.markRestarted !== false) {
      try {
        const restarted = await this.controller.controllerRestarted(this.actor);
        if (!restarted.ok) throw new Error(restarted.error.diagnostics.join("; "));
      } catch (error) {
        await this.releaseOwnership();
        throw error;
      }
    }
    const server = createServer((socket): void => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolveListen, reject): void => {
        server.once("error", reject);
        server.listen(this.socketPath, (): void => {
          server.off("error", reject);
          resolveListen();
        });
      });
      await chmod(this.socketPath, 0o600);
      if (this.decisionMonitor) {
        this.monitorTimer = setInterval((): void => { void this.pollDecisions(); }, 500);
        this.monitorTimer.unref();
      }
    } catch (error) {
      this.server = undefined;
      server.close();
      await removeFile(this.socketPath);
      await this.releaseOwnership();
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = undefined;
    await new Promise<void>((resolveClose, reject): void => {
      server.close((error): void => error ? reject(error) : resolveClose());
    });
    await removeFile(this.socketPath);
    await this.releaseOwnership();
  }

  private async acquireOwnership(): Promise<void> {
    const path = `${this.socketPath}.owner`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const file = await open(path, "wx", 0o600);
        try {
          await file.writeFile(`${JSON.stringify({ pid: process.pid, id: this.ownershipId })}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        this.ownershipHeld = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; id?: unknown };
        if (!Number.isSafeInteger(existing.pid) || (existing.pid as number) <= 0 || typeof existing.id !== "string") {
          throw new Error("Local controller ownership record is malformed; recovery is required");
        }
        if (processExists(existing.pid as number)) throw new Error("A local controller daemon already owns this project");
        await removeFile(path);
      }
    }
    throw new Error("Local controller ownership could not be acquired");
  }

  private async releaseOwnership(): Promise<void> {
    if (!this.ownershipHeld) return;
    this.ownershipHeld = false;
    const path = `${this.socketPath}.owner`;
    try {
      const existing = JSON.parse(await readFile(path, "utf8")) as { id?: unknown };
      if (existing.id === this.ownershipId) await removeFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async pollDecisions(): Promise<void> {
    if (!this.decisionMonitor || this.monitoring) return;
    this.monitoring = true;
    try {
      let cursor: string | undefined;
      do {
        const status = await this.controller.status(this.actor, { limit: 50, ...(cursor ? { cursor } : {}) });
        if (!status.ok) return;
        for (const attempt of status.value.executionAttempts) {
          if (!attempt.worker || (attempt.lifecycle !== "running" && attempt.lifecycle !== "pending-decision")) continue;
          const request = await this.decisionMonitor.nextDecision(attempt.worker);
          if (!request) continue;
          const recorded = await this.controller.recordWorkerObservation(this.actor, {
            attemptId: attempt.id,
            observation: {
              identity: attempt.worker,
              status: "blocked",
              artifactReferences: [],
              decision: {
                transportId: request.id,
                question: request.question,
                context: request.context,
                options: request.options,
                recommendation: request.recommendation,
              },
            },
          });
          if (recorded.ok) await this.decisionMonitor.acknowledgeDecision(attempt.worker, request.id);
        }
        cursor = status.value.nextCursor ?? undefined;
      } while (cursor);
    } catch {
      // The durable request stays in the private channel for a later bounded poll.
    } finally {
      this.monitoring = false;
    }
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, (): void => { socket.destroy(); });
    let body = "";
    let handled = false;
    socket.on("data", (chunk: string): void => {
      if (handled) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_IPC_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      socket.setTimeout(0);
      const record = body.slice(0, newline);
      void this.respond(socket, record);
    });
    socket.on("error", (): void => {});
  }

  private async respond(socket: Socket, record: string): Promise<void> {
    let id = "invalid";
    try {
      const request = parseRequest(record);
      id = request.id;
      if (!constantTimeEqual(request.token, this.token)) throw new Error("IPC authorization failed");
      const value = await this.dispatch(request.method, request.params);
      socket.end(`${JSON.stringify({ id, ok: true, value } satisfies IpcResponse)}\n`);
    } catch {
      socket.end(`${JSON.stringify({ id, ok: false, error: "Local controller request failed" } satisfies IpcResponse)}\n`);
    }
  }

  private async dispatch(method: RequestMethod, params: unknown[]): Promise<unknown> {
    if (method === "ping") return { pid: process.pid };
    switch (method) {
      case "prepare": return this.controller.prepare(this.actor, params[0] as PrepareRequest, params[1] as AdmissionSnapshot);
      case "submitProposal": return this.controller.submitProposal(this.actor, params[0] as string, params[1] as BatchProposal);
      case "approve": return this.controller.approve(this.actor, params[0] as string, params[1] as ApprovalRequest);
      case "preview": return this.controller.preview(this.actor, params[0] as string);
      case "getPreparation": return this.controller.getPreparation(this.actor, params[0] as string);
      case "validateApproval": return this.controller.validateApproval(this.actor, params[0] as string, params[1] as ApprovalRequest);
      case "startTicket": return this.controller.startTicket(this.actor, params[0] as import("./contracts.js").StartTicketRequest);
      case "attachAttempt": return this.controller.attachAttempt(this.actor, params[0] as AttemptRequest);
      case "pauseAttempt": return this.controller.pauseAttempt(this.actor, params[0] as AttemptRequest);
      case "resumeAttempt": return this.controller.resumeAttempt(this.actor, params[0] as AttemptRequest);
      case "takeOverAttempt": return this.controller.takeOverAttempt(this.actor, params[0] as AttemptRequest);
      case "returnAttempt": return this.controller.returnAttempt(this.actor, params[0] as AttemptRequest);
      case "answerDecision": return this.controller.answerDecision(this.actor, params[0] as AnswerDecisionRequest);
      case "recordWorkerObservation": return this.controller.recordWorkerObservation(this.actor, params[0] as RecordWorkerObservationRequest);
      case "status": return this.controller.status(this.actor, params[0] as PaginationRequest);
    }
  }
}

/** Stateless client: every operation is one authenticated request, so client exit has no daemon lifecycle effect. */
export class UnixControllerClient implements ControllerClient {
  constructor(private readonly socketPath: string, private readonly token: string) {}

  prepare(request: PrepareRequest, snapshot: AdmissionSnapshot): Promise<ControllerResult<PreparationRecord>> { return this.call("prepare", [request, snapshot]); }
  submitProposal(preparationId: string, proposal: BatchProposal): Promise<ControllerResult<PreparationRecord>> { return this.call("submitProposal", [preparationId, proposal]); }
  approve(preparationId: string, request: ApprovalRequest): Promise<ControllerResult<PreparationRecord>> { return this.call("approve", [preparationId, request]); }
  preview(preparationId: string): Promise<ControllerResult<string>> { return this.call("preview", [preparationId]); }
  getPreparation(preparationId: string): Promise<ControllerResult<PreparationRecord>> { return this.call("getPreparation", [preparationId]); }
  validateApproval(preparationId: string, request: ApprovalRequest): Promise<ControllerResult<PreparationRecord>> { return this.call("validateApproval", [preparationId, request]); }
  startTicket(request: import("./contracts.js").StartTicketRequest): Promise<ControllerResult<ExecutionAttempt>> { return this.call("startTicket", [request]); }
  attachAttempt(request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>> { return this.call("attachAttempt", [request]); }
  pauseAttempt(request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>> { return this.call("pauseAttempt", [request]); }
  resumeAttempt(request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>> { return this.call("resumeAttempt", [request]); }
  takeOverAttempt(request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>> { return this.call("takeOverAttempt", [request]); }
  returnAttempt(request: AttemptRequest): Promise<ControllerResult<ExecutionAttempt>> { return this.call("returnAttempt", [request]); }
  answerDecision(request: AnswerDecisionRequest): Promise<ControllerResult<ExecutionAttempt>> { return this.call("answerDecision", [request]); }
  recordWorkerObservation(request: RecordWorkerObservationRequest): Promise<ControllerResult<ExecutionAttempt>> { return this.call("recordWorkerObservation", [request]); }
  status(pagination: PaginationRequest): Promise<ControllerResult<ControllerStatus>> { return this.call("status", [pagination]); }

  async ping(): Promise<void> { await this.call<unknown>("ping", []); }

  private call<T>(method: RequestMethod, params: unknown[]): Promise<T> {
    const id = randomBytes(16).toString("base64url");
    const request: IpcRequest = { id, token: this.token, method, params };
    return new Promise<T>((resolveCall, reject): void => {
      const socket = createConnection(this.socketPath);
      let body = "";
      socket.setEncoding("utf8");
      socket.once("connect", (): void => { socket.write(`${JSON.stringify(request)}\n`); });
      socket.on("data", (chunk: string): void => {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > MAX_IPC_BYTES) socket.destroy(new Error("Local controller response exceeds its bound"));
      });
      socket.once("error", reject);
      socket.once("end", (): void => {
        try {
          const response = JSON.parse(body.trim()) as IpcResponse;
          if (response.id !== id || !response.ok) throw new Error("Local controller request failed");
          resolveCall(response.value as T);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

export function localDaemonPaths(statePath: string): LocalDaemonPaths {
  const stateDirectory = dirname(resolve(statePath));
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const socketDirectory = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `pi-herdr-${uid}`);
  const identity = createHash("sha256").update(resolve(statePath)).digest("hex").slice(0, 24);
  return {
    runtimeDirectory: stateDirectory,
    socketPath: join(socketDirectory, `${identity}.sock`),
    tokenPath: join(stateDirectory, "controller-ipc-token"),
    workerBridgeDirectory: join(stateDirectory, "worker-bridge"),
  };
}

export async function connectOrStartLocalController(statePath: string): Promise<UnixControllerClient> {
  const paths = localDaemonPaths(statePath);
  const token = await readOrCreateToken(paths.tokenPath);
  const client = new UnixControllerClient(paths.socketPath, token);
  try {
    await client.ping();
    return client;
  } catch (error) {
    if (!isConnectionFailure(error)) throw error;
  }
  const child = spawn(process.execPath, [DAEMON_BIN_PATH, "--state", resolve(statePath)], {
    detached: true,
    stdio: "ignore",
    cwd: dirname(resolve(statePath)),
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await client.ping();
      return client;
    } catch (error) {
      if (!isConnectionFailure(error) || Date.now() >= deadline) throw error;
      await new Promise((resolveWait): void => { setTimeout(resolveWait, 50); });
    }
  }
}

export async function readOrCreateToken(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  try {
    const file = await open(path, "wx", 0o600);
    const token = randomBytes(32).toString("base64url");
    try {
      await file.writeFile(`${token}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const token = (await readFile(path, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Local controller token is malformed");
    await chmod(path, 0o600);
    return token;
  }
}

function parseRequest(record: string): IpcRequest {
  const value: unknown = JSON.parse(record);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed IPC request");
  const request = value as Partial<IpcRequest>;
  const methods = new Set<RequestMethod>([
    "ping", "prepare", "submitProposal", "approve", "preview", "getPreparation", "validateApproval",
    "startTicket", "attachAttempt", "pauseAttempt", "resumeAttempt", "takeOverAttempt", "returnAttempt", "answerDecision",
    "recordWorkerObservation", "status",
  ]);
  if (typeof request.id !== "string" || request.id.length > 200 || typeof request.token !== "string" ||
    !methods.has(request.method as RequestMethod) || !Array.isArray(request.params)) throw new Error("Malformed IPC request");
  return request as IpcRequest;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return leftDigest.equals(rightDigest);
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    await new Promise<void>((resolveConnected, reject): void => {
      const socket = createConnection(path);
      socket.once("connect", (): void => { socket.destroy(); resolveConnected(); });
      socket.once("error", reject);
    });
    throw new Error("A local controller daemon already owns this project");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      await removeFile(path);
      return;
    }
    throw error;
  }
}

async function removeFile(path: string): Promise<void> {
  try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isConnectionFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET";
}
