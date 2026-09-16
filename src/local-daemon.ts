import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { spawn } from "node:child_process";

import type {
  AcceptCandidateRequest,
  AdmissionSnapshot,
  AnswerDecisionRequest,
  ApprovalRequest,
  AttemptRequest,
  BatchProposal,
  ControllerResult,
  CandidateReceipt,
  CaptureCandidateRequest,
  ControllerStatus,
  ExecutionAttempt,
  PaginationRequest,
  PreparationRecord,
  WorkerIdentity,
  WorkerObservation,
  PrepareRequest,
  StartTicketRequest,
  RecordWorkerObservationRequest,
} from "./contracts.js";
import type { OrchestratorCommand, OrchestratorRecord, StartOrchestratorRequest } from "./coordination-contracts.js";
import { isContextSample } from "./coordination-validation.js";
import { PreparationController } from "./controller.js";
import { isAcceptCandidateCommand, mapAcceptCandidateCommand } from "./presentation-mappers.js";
import { isBatchProposal, isCapturedModel, isSourceEvidence, isWorkerIdentity } from "./state-validation.js";
import type { WorkerDecisionRequest } from "./worker-bridge-protocol.js";

const MAX_IPC_BYTES = 6 * 1024 * 1024;
const DAEMON_BIN_PATH = fileURLToPath(new URL("../bin/herdr-controller.mjs", import.meta.url));

export interface WorkerExecutionMonitor {
  inspect(identity: WorkerIdentity): Promise<WorkerObservation>;
  nextDecision(identity: WorkerIdentity): Promise<WorkerDecisionRequest | undefined>;
  acknowledgeDecision(identity: WorkerIdentity, decisionId: string): Promise<void>;
  nextOrchestratorCommand?(identity: WorkerIdentity): Promise<OrchestratorCommand | undefined>;
}

export interface LocalDaemonPaths {
  runtimeDirectory: string;
  socketPath: string;
  tokenPath: string;
  workerBridgeDirectory: string;
  evidenceDirectory: string;
}

export interface ControllerClient {
  startOrchestrator(request: StartOrchestratorRequest): Promise<ControllerResult<OrchestratorRecord>>;
  refreshOrchestrator(request: { preparationId: string; resume?: boolean }): Promise<ControllerResult<OrchestratorRecord>>;
  answerOrchestratorDecision(request: { preparationId: string; decisionId: string; answer: string; answeredBy: string }): Promise<ControllerResult<OrchestratorRecord>>;
  prepare(request: PrepareRequest, snapshot: AdmissionSnapshot): Promise<ControllerResult<PreparationRecord>>;
  submitProposal(preparationId: string, proposal: BatchProposal): Promise<ControllerResult<PreparationRecord>>;
  approve(preparationId: string, request: ApprovalRequest): Promise<ControllerResult<PreparationRecord>>;
  preview(preparationId: string): Promise<ControllerResult<string>>;
  getPreparation(preparationId: string): Promise<ControllerResult<PreparationRecord>>;
  validateApproval(preparationId: string, request: ApprovalRequest): Promise<ControllerResult<PreparationRecord>>;
  startTicket(request: import("./contracts.js").StartTicketRequest): Promise<ControllerResult<ExecutionAttempt>>;
  captureCandidate(request: CaptureCandidateRequest): Promise<ControllerResult<CandidateReceipt>>;
  acceptCandidate(request: AcceptCandidateRequest): Promise<ControllerResult<ExecutionAttempt>>;
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
  private readonly orchestrating = new Set<string>();
  private readonly ownershipId = randomBytes(16).toString("base64url");
  private ownershipHeld = false;

  constructor(
    private readonly controller: PreparationController,
    private readonly actor: symbol,
    private readonly socketPath: string,
    private readonly token: string,
    private readonly workerMonitor?: WorkerExecutionMonitor,
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
      if (this.workerMonitor) {
        this.monitorTimer = setInterval((): void => { void this.pollWorkers(); void this.pollOrchestrators(); }, 500);
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

  private async pollOrchestrators(): Promise<void> {
    if (!this.workerMonitor?.nextOrchestratorCommand) return;
    try {
      let cursor: string | undefined;
      do {
        const status = await this.controller.status(this.actor, { limit: 50, ...(cursor ? { cursor } : {}) });
        if (!status.ok) return;
        for (const preparation of status.value.preparations) {
          if (!preparation.orchestrator || !["running", "rotation-pending"].includes(preparation.orchestrator.phase) || this.orchestrating.has(preparation.id)) continue;
          this.orchestrating.add(preparation.id);
          void this.pollOrchestrator(preparation.id).catch(async (): Promise<void> => {
            await this.controller.failOrchestrator(this.actor, { preparationId: preparation.id, generation: preparation.orchestrator!.generation });
          }).finally((): void => { this.orchestrating.delete(preparation.id); });
        }
        cursor = status.value.nextCursor ?? undefined;
      } while (cursor);
    } catch { /* State read failure does not authorize a model launch. */ }
  }

  private async pollOrchestrator(preparationId: string): Promise<void> {
    const refreshed = await this.controller.refreshOrchestrator(this.actor, { preparationId });
    if (!refreshed.ok || refreshed.value.phase !== "running" || !refreshed.value.session) return;
    const session = refreshed.value.session;
    const observation = await this.workerMonitor!.inspect(session);
    if (!observation.safeToCheckpoint) return;
    const command = await this.workerMonitor!.nextOrchestratorCommand!(session);
    if (!command) return;
    const outcome = await this.controller.orchestratorOperation(this.actor, command);
    if (command.operation.kind !== "wait" && command.operation.kind !== "escalate" || !outcome.ok) {
      await this.controller.continueOrchestrator(this.actor, { preparationId,
        outcome: outcome.ok ? "Requested operation finished. Inspect durable attempt state and evidence; completion is not acceptance." : `Operation rejected: ${outcome.error.diagnostics.join("; ").slice(0, 2_000)}` });
    }
  }

  private async pollWorkers(): Promise<void> {
    if (!this.workerMonitor || this.monitoring) return;
    this.monitoring = true;
    try {
      let cursor: string | undefined;
      do {
        const status = await this.controller.status(this.actor, { limit: 50, ...(cursor ? { cursor } : {}) });
        if (!status.ok) return;
        for (const attempt of status.value.executionAttempts) {
          if (!attempt.worker || (attempt.lifecycle !== "running" && attempt.lifecycle !== "pending-decision")) continue;
          const controlGeneration = attempt.controlGeneration ?? 0;
          let failureControlGeneration = controlGeneration;
          try {
            const request = await this.workerMonitor.nextDecision(attempt.worker);
            if (request) {
              const recorded = await this.controller.recordWorkerObservation(this.actor, {
                attemptId: attempt.id,
                controlGeneration,
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
              const durableDecision = recorded.ok
                ? recorded.value.decisions.find((decision): boolean => decision.id === request.id)
                : undefined;
              if (
                recorded.ok && recorded.value.controlGeneration === controlGeneration + 1 &&
                recorded.value.lifecycle !== "needs-attention" && durableDecision &&
                durableDecision.question === request.question && durableDecision.context === request.context &&
                durableDecision.recommendation === request.recommendation &&
                JSON.stringify(durableDecision.options) === JSON.stringify(request.options)
              ) {
                failureControlGeneration = recorded.value.controlGeneration;
                await this.workerMonitor.acknowledgeDecision(attempt.worker, request.id);
              }
              continue;
            }
            const observation = await this.workerMonitor.inspect(attempt.worker);
            const recorded = await this.controller.recordWorkerObservation(this.actor, {
              attemptId: attempt.id,
              controlGeneration,
              observation,
            });
            const preparation = status.value.preparations.find((item): boolean => item.id === attempt.preparationId);
            const observedTokens = observation.context?.tokens;
            const checkpointNeeded = observedTokens === undefined || observedTokens === null ||
              observedTokens >= preparation!.effectiveContextLimit!.handoffTokens || recorded.ok && recorded.value.handoff?.phase === "requested";
            if (recorded.ok && recorded.value.lifecycle === "running" && observation.safeToCheckpoint === true && checkpointNeeded) {
              await this.controller.checkpointWorker(this.actor, { attemptId: attempt.id });
            }
          } catch {
            try {
              await this.controller.recordWorkerObservation(this.actor, {
                attemptId: attempt.id,
                controlGeneration: failureControlGeneration,
                observation: {
                  identity: attempt.worker,
                  status: "unknown",
                  artifactReferences: [],
                },
              });
            } catch {
              // A later status poll may retry only if durable state still permits monitoring.
            }
          }
        }
        cursor = status.value.nextCursor ?? undefined;
      } while (cursor);
    } catch {
      // A controller status failure leaves durable state unchanged for a later bounded poll.
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
    validateMethodParams(method, params);
    if (method === "ping") return { pid: process.pid };
    switch (method) {
      case "prepare": return this.controller.prepare(this.actor, params[0] as PrepareRequest, params[1] as AdmissionSnapshot);
      case "submitProposal": return this.controller.submitProposal(this.actor, params[0] as string, params[1] as BatchProposal);
      case "approve": return this.controller.approve(this.actor, params[0] as string, params[1] as ApprovalRequest);
      case "preview": return this.controller.preview(this.actor, params[0] as string);
      case "getPreparation": return this.controller.getPreparation(this.actor, params[0] as string);
      case "validateApproval": return this.controller.validateApproval(this.actor, params[0] as string, params[1] as ApprovalRequest);
      case "startOrchestrator": return this.controller.startOrchestrator(this.actor, params[0] as StartOrchestratorRequest);
      case "refreshOrchestrator": return this.controller.refreshOrchestrator(this.actor, params[0] as { preparationId: string; resume?: boolean });
      case "answerOrchestratorDecision": return this.controller.answerOrchestratorDecision(this.actor, params[0] as { preparationId: string; decisionId: string; answer: string; answeredBy: string });
      case "startTicket": return this.controller.startTicket(this.actor, params[0] as import("./contracts.js").StartTicketRequest);
      case "captureCandidate": return this.controller.captureCandidate(this.actor, params[0] as CaptureCandidateRequest);
      case "acceptCandidate": return this.controller.acceptCandidate(this.actor, mapAcceptCandidateCommand(params[0]));
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

  startOrchestrator(request: StartOrchestratorRequest): Promise<ControllerResult<OrchestratorRecord>> { return this.call("startOrchestrator", [request]); }
  refreshOrchestrator(request: { preparationId: string; resume?: boolean }): Promise<ControllerResult<OrchestratorRecord>> { return this.call("refreshOrchestrator", [request]); }
  answerOrchestratorDecision(request: { preparationId: string; decisionId: string; answer: string; answeredBy: string }): Promise<ControllerResult<OrchestratorRecord>> { return this.call("answerOrchestratorDecision", [request]); }
  prepare(request: PrepareRequest, snapshot: AdmissionSnapshot): Promise<ControllerResult<PreparationRecord>> { return this.call("prepare", [request, snapshot]); }
  submitProposal(preparationId: string, proposal: BatchProposal): Promise<ControllerResult<PreparationRecord>> { return this.call("submitProposal", [preparationId, proposal]); }
  approve(preparationId: string, request: ApprovalRequest): Promise<ControllerResult<PreparationRecord>> { return this.call("approve", [preparationId, request]); }
  preview(preparationId: string): Promise<ControllerResult<string>> { return this.call("preview", [preparationId]); }
  getPreparation(preparationId: string): Promise<ControllerResult<PreparationRecord>> { return this.call("getPreparation", [preparationId]); }
  validateApproval(preparationId: string, request: ApprovalRequest): Promise<ControllerResult<PreparationRecord>> { return this.call("validateApproval", [preparationId, request]); }
  startTicket(request: import("./contracts.js").StartTicketRequest): Promise<ControllerResult<ExecutionAttempt>> { return this.call("startTicket", [request]); }
  captureCandidate(request: CaptureCandidateRequest): Promise<ControllerResult<CandidateReceipt>> { return this.call("captureCandidate", [request]); }
  acceptCandidate(request: AcceptCandidateRequest): Promise<ControllerResult<ExecutionAttempt>> { return this.call("acceptCandidate", [request]); }
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
    evidenceDirectory: join(stateDirectory, "acceptance-evidence"),
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
    "startTicket", "captureCandidate", "acceptCandidate", "attachAttempt", "pauseAttempt", "resumeAttempt", "takeOverAttempt", "returnAttempt", "answerDecision",
    "recordWorkerObservation", "status", "startOrchestrator", "refreshOrchestrator", "answerOrchestratorDecision",
  ]);
  if (typeof request.id !== "string" || request.id.length > 200 || typeof request.token !== "string" ||
    !methods.has(request.method as RequestMethod) || !Array.isArray(request.params)) throw new Error("Malformed IPC request");
  return request as IpcRequest;
}

function validateMethodParams(method: RequestMethod, params: unknown[]): void {
  let valid = false;
  switch (method) {
    case "ping": valid = params.length === 0; break;
    case "prepare": valid = params.length === 2 && isPrepareRequest(params[0]) && isAdmissionSnapshot(params[1]); break;
    case "submitProposal": valid = params.length === 2 && boundedText(params[0]) && isBatchProposal(params[1]); break;
    case "approve":
    case "validateApproval": valid = params.length === 2 && boundedText(params[0]) && isApprovalRequest(params[1]); break;
    case "preview":
    case "getPreparation": valid = params.length === 1 && boundedText(params[0]); break;
    case "startOrchestrator": valid = params.length === 1 && isObjectWithKeys(params[0], ["preparationId", "workspaceId"]) && boundedText(params[0].preparationId) && boundedText(params[0].workspaceId); break;
    case "refreshOrchestrator": valid = params.length === 1 && isObjectWithKeys(params[0], ["preparationId", "resume"]) && boundedText(params[0].preparationId) && (params[0].resume === undefined || typeof params[0].resume === "boolean"); break;
    case "answerOrchestratorDecision": valid = params.length === 1 && isObjectWithKeys(params[0], ["preparationId", "decisionId", "answer", "answeredBy"]) && [params[0].preparationId, params[0].decisionId, params[0].answer, params[0].answeredBy].every((item): boolean => boundedText(item)); break;
    case "startTicket": valid = params.length === 1 && isStartTicketRequest(params[0]); break;
    case "captureCandidate": valid = params.length === 1 && isAttemptRequest(params[0]); break;
    case "acceptCandidate": valid = params.length === 1 && isAcceptCandidateCommand(params[0]); break;
    case "attachAttempt":
    case "pauseAttempt":
    case "resumeAttempt":
    case "takeOverAttempt":
    case "returnAttempt": valid = params.length === 1 && isAttemptRequest(params[0]); break;
    case "answerDecision": valid = params.length === 1 && isAnswerDecisionRequest(params[0]); break;
    case "recordWorkerObservation": valid = params.length === 1 && isRecordWorkerObservationRequest(params[0]); break;
    case "status": valid = params.length === 1 && isPaginationRequest(params[0]); break;
  }
  if (!valid) throw new Error("Malformed IPC method parameters");
}

function isPrepareRequest(value: unknown): value is PrepareRequest {
  return isObjectWithKeys(value, ["specReference", "controllerName"]) &&
    boundedText(value.specReference) && boundedText(value.controllerName);
}

function isAdmissionSnapshot(value: unknown): value is AdmissionSnapshot {
  if (!isObjectWithKeys(value, ["project", "runtime", "model"])) return false;
  const project = value.project;
  const runtime = value.runtime;
  const model = value.model;
  return isObjectWithKeys(project, ["root", "identity", "head", "branch", "instructionFiles"]) &&
    [project.root, project.identity, project.head, project.branch].every((item): boolean => boundedText(item)) &&
    boundedStringArray(project.instructionFiles, 200) &&
    isObjectWithKeys(runtime, ["platform", "piVersion", "herdrVersion", "projectTrusted", "skillCommands", "toolNames"]) &&
    (runtime.platform === "linux" || runtime.platform === "darwin") &&
    (runtime.piVersion === undefined || boundedText(runtime.piVersion)) &&
    (runtime.herdrVersion === undefined || boundedText(runtime.herdrVersion)) &&
    typeof runtime.projectTrusted === "boolean" && boundedStringArray(runtime.skillCommands, 200) &&
    boundedStringArray(runtime.toolNames, 200) &&
    isObjectWithKeys(model, ["provider", "id", "thinkingLevel", "contextWindow", "authenticated", "available", "authError"]) &&
    isCapturedModel(model) && typeof model.authenticated === "boolean" && typeof model.available === "boolean" &&
    (model.authError === undefined || boundedText(model.authError));
}

function isApprovalRequest(value: unknown): value is ApprovalRequest {
  return isObjectWithKeys(value, ["approvedBy", "proposalDigest", "projectHead", "model", "evidence"]) &&
    boundedText(value.approvedBy) && digestText(value.proposalDigest) && boundedText(value.projectHead) &&
    isCapturedModel(value.model) && Array.isArray(value.evidence) && value.evidence.length <= 1_000 &&
    value.evidence.every(isSourceEvidence);
}

function isStartTicketRequest(value: unknown): value is StartTicketRequest {
  return isObjectWithKeys(value, ["preparationId", "ticketIdentity", "workspaceId"]) &&
    [value.preparationId, value.ticketIdentity, value.workspaceId].every((item): boolean => boundedText(item));
}

function isAttemptRequest(value: unknown): value is AttemptRequest {
  return isObjectWithKeys(value, ["attemptId"]) && boundedText(value.attemptId);
}

function isAnswerDecisionRequest(value: unknown): value is AnswerDecisionRequest {
  return isObjectWithKeys(value, ["attemptId", "decisionId", "answer", "answeredBy"]) &&
    boundedText(value.attemptId) && boundedText(value.decisionId) && boundedText(value.answer, 4_000) &&
    boundedText(value.answeredBy, 500);
}

function isRecordWorkerObservationRequest(value: unknown): value is RecordWorkerObservationRequest {
  return isObjectWithKeys(value, ["attemptId", "controlGeneration", "observation"]) && boundedText(value.attemptId) &&
    typeof value.controlGeneration === "number" && Number.isSafeInteger(value.controlGeneration) &&
    value.controlGeneration >= 0 && isWorkerObservation(value.observation);
}

function isWorkerObservation(value: unknown): value is WorkerObservation {
  if (!isObjectWithKeys(value, ["identity", "status", "artifactReferences", "decision", "diagnostic", "completionText", "settled", "outstandingJobs", "context", "safeToCheckpoint"])) return false;
  if (!isWorkerIdentity(value.identity) || !["ready", "working", "idle", "done", "blocked", "missing", "unknown"].includes(value.status as string)) return false;
  if (!boundedStringArray(value.artifactReferences, 50, true)) return false;
  if (value.diagnostic !== undefined && !boundedText(value.diagnostic, 4_096)) return false;
  if (value.completionText !== undefined && !boundedText(value.completionText, 64_000)) return false;
  if (value.settled !== undefined && typeof value.settled !== "boolean") return false;
  if (value.outstandingJobs !== undefined && !boundedStringArray(value.outstandingJobs, 50, true)) return false;
  if (value.context !== undefined && !isContextSample(value.context)) return false;
  if (value.safeToCheckpoint !== undefined && typeof value.safeToCheckpoint !== "boolean") return false;
  if (value.decision === undefined) return true;
  const decision = value.decision;
  return isObjectWithKeys(decision, ["transportId", "question", "context", "options", "recommendation"]) &&
    (decision.transportId === undefined || (
      typeof decision.transportId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(decision.transportId)
    )) &&
    boundedText(decision.question, 4_000) && boundedText(decision.context, 4_000) &&
    boundedStringArray(decision.options, 20) && decision.options.length >= 1 &&
    decision.options.every((option): boolean => option.length <= 1_000) && boundedText(decision.recommendation, 4_000);
}

function isPaginationRequest(value: unknown): value is PaginationRequest {
  return isObjectWithKeys(value, ["limit", "cursor"]) && Number.isSafeInteger(value.limit) &&
    (value.cursor === undefined || boundedText(value.cursor));
}

function isObjectWithKeys(value: unknown, allowed: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = new Set(allowed);
  return Object.keys(value).every((key): boolean => keys.has(key));
}

function boundedText(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function boundedStringArray(value: unknown, maximumItems: number, allowEmpty = false): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && (allowEmpty || value.length > 0) &&
    value.every((item): boolean => boundedText(item));
}

function digestText(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
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
