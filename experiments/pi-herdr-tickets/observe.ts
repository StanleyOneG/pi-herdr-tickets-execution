/** Diagnostic extension for the Herdr fresh-session experiment. Not a ticket acceptance gate. */
import { mkdirSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("ticket-observe-dir", {
    description: "Write fresh-session experiment evidence to this directory",
    type: "string",
  });
  // CLI extension flag values are available after factory initialization.
  function outputDirectory() {
    const configured = pi.getFlag("ticket-observe-dir");
    if (typeof configured !== "string" || !configured) {
      throw new Error("observe.ts requires --ticket-observe-dir");
    }
    return resolve(configured);
  }
  let sequence = 0;
  let firstContext = true;
  let run = 0;

  function save(name: string, data: unknown) {
    const directory = outputDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, name);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, target);
  }

  function identity(ctx: ExtensionContext) {
    return {
      pid: process.pid,
      mode: ctx.mode,
      cwd: ctx.cwd,
      pane: process.env.HERDR_PANE_ID,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      thinking: ctx.thinkingLevel,
    };
  }

  function event(name: string, ctx: ExtensionContext, data = {}) {
    const directory = outputDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(join(directory, "events.jsonl"), JSON.stringify({
      sequence: ++sequence, at: new Date().toISOString(), event: name,
      run, ...identity(ctx), ...data,
    }) + "\n", { mode: 0o600 });
  }

  pi.on("session_start", (e, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    save("startup.json", {
      ...identity(ctx), reason: e.reason,
      historyEntries: entries.filter(e => ["message", "custom_message", "compaction", "branch_summary"].includes(e.type)).length,
      tools: pi.getActiveTools(),
    });
    event("session_start", ctx);
  });

  pi.on("before_agent_start", (e, ctx) => {
    ++run;
    const options = e.systemPromptOptions;
    save(`resources-${run}.json`, {
      ...identity(ctx),
      tools: pi.getActiveTools(),
      commands: pi.getCommands(),
      contextFiles: options.contextFiles?.map(f => f.path),
      skills: options.skills?.map(s => ({ name: s.name, filePath: s.filePath })),
      expandedPrompt: e.prompt,
    });
    event("before_agent_start", ctx);
  });

  pi.on("context", (e, ctx) => {
    if (firstContext) {
      firstContext = false;
      save("first-context.json", {
        ...identity(ctx),
        roles: e.messages.map(m => m.role),
        messages: e.messages,
      });
    }
  });

  pi.on("agent_start", (_, ctx) => event("agent_start", ctx));
  pi.on("agent_end", (_, ctx) => event("agent_end", ctx));
  pi.on("tool_execution_start", (e, ctx) => event("tool", ctx, { tool: e.toolName }));
  pi.on("session_compact", (_, ctx) => event("compaction", ctx));
  pi.on("agent_settled", (_, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const messages = branch.filter(e => e.type === "message").map(e => e.message);
    const last = messages.filter(m => m.role === "assistant").at(-1);
    save(`settled-${run}.json`, {
      ...identity(ctx), run, idle: ctx.isIdle(), pending: ctx.hasPendingMessages(),
      contextUsage: ctx.getContextUsage(),
      stopReason: last?.stopReason,
      errorMessage: last?.errorMessage,
      answer: last?.content.filter(c => c.type === "text").map(c => c.text).join("\n"),
      userMessages: messages.filter(m => m.role === "user").length,
      assistantMessages: messages.filter(m => m.role === "assistant").length,
    });
    event("agent_settled", ctx);
  });
  pi.on("session_shutdown", (_, ctx) => event("session_shutdown", ctx));
}
