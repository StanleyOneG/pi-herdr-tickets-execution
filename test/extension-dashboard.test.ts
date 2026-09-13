import assert from "node:assert/strict";
import test from "node:test";

import type {
  ControllerResult,
  ControllerStatus,
  ExecutionAttempt,
  PreparationRecord,
} from "../src/contracts.js";
import type { ControllerClient } from "../src/local-daemon.js";
import { registerHerdrExtension } from "../src/extension.js";

interface RegisteredCommand {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function ok<T>(value: T): ControllerResult<T> {
  return { ok: true, value };
}

function attempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    id: "attempt-1",
    preparationId: "preparation-1",
    proposalDigest: "a".repeat(64),
    ticketIdentity: "ticket-4",
    workspaceId: "workspace-1",
    lifecycle: "running",
    owner: { instanceId: "daemon-1", pid: 123 },
    createdAt: "2026-09-12T14:00:00.000Z",
    updatedAt: "2026-09-12T14:01:00.000Z",
    worker: {
      workspaceId: "workspace-1",
      tabId: "tab-1",
      paneId: "pane-1",
      agentName: "herdr-owned-agent",
      piPid: 4242,
      sessionId: "session-1",
      sessionFile: "/sessions/session-1.jsonl",
      cwd: "/repo-worktrees/ticket-4",
      model: { provider: "test", id: "reasoner", thinkingLevel: "high", contextWindow: 220_000 },
      mode: "tui",
      initialHistoryEntries: 0,
      skillCommands: ["skill:implement", "skill:tdd", "skill:code-review", "skill:handoff"],
      toolNames: ["read", "bash", "edit", "write"],
      contextFiles: ["/repo-worktrees/ticket-4/AGENTS.md"],
    },
    decisions: [],
    artifactReferences: ["/evidence/turn-1.json"],
    diagnostics: [],
    ...overrides,
  };
}

function clientFixture(initialAttempts: ExecutionAttempt[] = []): {
  client: ControllerClient;
  starts: Array<{ preparationId: string; ticketIdentity: string; workspaceId: string }>;
  controls: string[];
  answers: Array<{ attemptId: string; decisionId: string; answer: string; answeredBy: string }>;
  attempts: ExecutionAttempt[];
} {
  const attempts = structuredClone(initialAttempts);
  const starts: Array<{ preparationId: string; ticketIdentity: string; workspaceId: string }> = [];
  const controls: string[] = [];
  const answers: Array<{ attemptId: string; decisionId: string; answer: string; answeredBy: string }> = [];
  const unsupported = async (): Promise<never> => { throw new Error("unsupported test operation"); };
  const client: ControllerClient = {
    prepare: unsupported,
    submitProposal: unsupported,
    approve: unsupported,
    preview: unsupported,
    getPreparation: unsupported,
    validateApproval: unsupported,
    async startTicket(request) {
      starts.push(structuredClone(request));
      const started = attempt({
        preparationId: request.preparationId,
        ticketIdentity: request.ticketIdentity,
        workspaceId: request.workspaceId,
      });
      attempts.splice(0, attempts.length, started);
      return ok(structuredClone(started));
    },
    async attachAttempt(request) {
      controls.push(`attach:${request.attemptId}`);
      return ok(structuredClone(attempts[0]!));
    },
    async pauseAttempt(request) {
      controls.push(`pause:${request.attemptId}`);
      attempts[0] = { ...attempts[0]!, lifecycle: "paused" };
      return ok(structuredClone(attempts[0]!));
    },
    async resumeAttempt(request) {
      controls.push(`resume:${request.attemptId}`);
      attempts[0] = { ...attempts[0]!, lifecycle: "running" };
      return ok(structuredClone(attempts[0]!));
    },
    async takeOverAttempt(request) {
      controls.push(`takeover:${request.attemptId}`);
      attempts[0] = { ...attempts[0]!, lifecycle: "takeover" };
      return ok(structuredClone(attempts[0]!));
    },
    async returnAttempt(request) {
      controls.push(`return:${request.attemptId}`);
      attempts[0] = { ...attempts[0]!, lifecycle: "running" };
      return ok(structuredClone(attempts[0]!));
    },
    async answerDecision(request) {
      answers.push(structuredClone(request));
      const current = attempts[0]!;
      attempts[0] = {
        ...current,
        lifecycle: "running",
        decisions: current.decisions.map((decision) => decision.id === request.decisionId ? {
          ...decision,
          state: "delivered" as const,
          answer: request.answer,
          answeredBy: request.answeredBy,
          answeredAt: "2026-09-12T14:02:00.000Z",
          deliveredAt: "2026-09-12T14:02:01.000Z",
        } : decision),
      };
      return ok(structuredClone(attempts[0]!));
    },
    recordWorkerObservation: unsupported,
    async status(): Promise<ControllerResult<ControllerStatus>> {
      return ok({ preparations: [], executionAttempts: structuredClone(attempts), nextCursor: null, hasMore: false });
    },
  };
  return { client, starts, controls, answers, attempts };
}

function extensionFixture(client: ControllerClient): {
  commands: Map<string, RegisteredCommand>;
  notifications: string[];
  widgets: string[][];
  statuses: string[];
  sentModelMessages: string[];
  context: unknown;
} {
  const commands = new Map<string, RegisteredCommand>();
  const notifications: string[] = [];
  const widgets: string[][] = [];
  const statuses: string[] = [];
  const sentModelMessages: string[] = [];
  const pi = {
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    async exec(_command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
      const key = args.join(" ");
      const values: Record<string, string> = {
        "rev-parse --show-toplevel": "/repo",
        "rev-parse HEAD": "0123456789012345678901234567890123456789",
        "branch --show-current": "main",
        "rev-parse --git-common-dir": ".git",
        "remote get-url origin": "git@github.com:example/project.git",
      };
      return { code: values[key] === undefined ? 1 : 0, stdout: values[key] ?? "", stderr: "" };
    },
    getThinkingLevel(): string { return "high"; },
    getCommands(): unknown[] { return []; },
    getActiveTools(): string[] { return []; },
    async sendUserMessage(message: string): Promise<void> { sentModelMessages.push(message); },
  };
  registerHerdrExtension(pi as never, {
    connectController: async (): Promise<ControllerClient> => client,
    workspaceId: (): string | undefined => "workspace-1",
  });
  const context = {
    cwd: "/repo",
    hasUI: true,
    ui: {
      notify(message: string): void { notifications.push(message); },
      setWidget(_key: string, lines: string[] | undefined): void { if (lines) widgets.push(lines); },
      setStatus(_key: string, text: string | undefined): void { if (text) statuses.push(text); },
      async input(): Promise<string | undefined> { return "local developer"; },
      async confirm(): Promise<boolean> { return true; },
    },
  };
  return { commands, notifications, widgets, statuses, sentModelMessages, context };
}

async function runCommand(fixture: ReturnType<typeof extensionFixture>, name: string, args = ""): Promise<void> {
  const command = fixture.commands.get(name);
  assert.ok(command, `command ${name} is registered`);
  await command.handler(args, fixture.context);
}

test("dashboard starts an approved ticket through the daemon client and renders durable status without a model event", async (): Promise<void> => {
  const controller = clientFixture();
  const extension = extensionFixture(controller.client);

  await runCommand(extension, "herdr-start", "preparation-1 ticket-4");

  assert.deepEqual(controller.starts, [{ preparationId: "preparation-1", ticketIdentity: "ticket-4", workspaceId: "workspace-1" }]);
  assert.match(extension.notifications.at(-1) ?? "", /attempt-1.*running.*ticket-4/i);
  assert.ok(extension.widgets.at(-1)?.some((line): boolean => line.includes("session-1")));
  assert.ok(extension.statuses.at(-1)?.includes("1 active"));
  assert.deepEqual(extension.sentModelMessages, []);
});

test("dashboard attach focuses the durable worker and provides a non-takeover attach command", async (): Promise<void> => {
  const controller = clientFixture([attempt()]);
  const extension = extensionFixture(controller.client);

  await runCommand(extension, "herdr-attach", "attempt-1");

  assert.deepEqual(controller.controls, ["attach:attempt-1"]);
  assert.match(extension.notifications.at(-1) ?? "", /herdr agent attach herdr-owned-agent/);
  assert.doesNotMatch(extension.notifications.at(-1) ?? "", /--takeover/);
});

test("dashboard pause, resume, takeover, and return controls use durable attempt identities", async (): Promise<void> => {
  const controller = clientFixture([attempt()]);
  const extension = extensionFixture(controller.client);

  await runCommand(extension, "herdr-pause", "attempt-1");
  await runCommand(extension, "herdr-resume", "attempt-1");
  await runCommand(extension, "herdr-takeover", "attempt-1");
  assert.match(extension.notifications.at(-1) ?? "", /herdr agent attach herdr-owned-agent --takeover/);
  await runCommand(extension, "herdr-return", "attempt-1");

  assert.deepEqual(controller.controls, ["pause:attempt-1", "resume:attempt-1", "takeover:attempt-1", "return:attempt-1"]);
  assert.match(extension.notifications.at(-1) ?? "", /attempt-1.*running/i);
  assert.deepEqual(extension.sentModelMessages, []);
});

test("pending questions remain discoverable through bounded status pagination", async (): Promise<void> => {
  const pending = attempt({
    lifecycle: "pending-decision",
    decisions: [{
      id: "decision-later",
      state: "pending",
      requestedAt: "2026-09-12T14:01:00.000Z",
      question: "Question on the next bounded page?",
      context: "Older completed attempts fill the first page.",
      options: ["Continue", "Pause"],
      recommendation: "Continue.",
    }],
  });
  const controller = clientFixture([pending]);
  controller.client.status = async (pagination): Promise<ControllerResult<ControllerStatus>> => pagination.cursor
    ? ok({ preparations: [], executionAttempts: [pending], nextCursor: null, hasMore: false })
    : ok({ preparations: [], executionAttempts: [], nextCursor: "next-page", hasMore: true });
  const extension = extensionFixture(controller.client);

  await runCommand(extension, "herdr-questions", "attempt-1");

  assert.match(extension.notifications.at(-1) ?? "", /decision-later.*next bounded page/is);
});

test("dashboard surfaces pending local questions and records an explicit answer without a model event", async (): Promise<void> => {
  const pending = attempt({
    lifecycle: "pending-decision",
    decisions: [{
      id: "decision-1",
      state: "pending",
      requestedAt: "2026-09-12T14:01:00.000Z",
      question: "Which test database should this ticket use?",
      context: "Ticket 4 needs an isolated nonproduction database.",
      options: ["SQLite file", "Dedicated Postgres schema"],
      recommendation: "Use a per-worktree SQLite file.",
    }],
  });
  const controller = clientFixture([pending]);
  const extension = extensionFixture(controller.client);

  await runCommand(extension, "herdr-questions", "attempt-1");
  assert.match(extension.notifications.at(-1) ?? "", /decision-1.*Which test database.*isolated nonproduction.*SQLite file.*Dedicated Postgres schema.*per-worktree SQLite/is);

  await runCommand(extension, "herdr-answer", "attempt-1 decision-1 Use a per-worktree SQLite file");
  assert.deepEqual(controller.answers, [{
    attemptId: "attempt-1",
    decisionId: "decision-1",
    answer: "Use a per-worktree SQLite file",
    answeredBy: "local developer",
  }]);
  assert.deepEqual(extension.sentModelMessages, []);
});
