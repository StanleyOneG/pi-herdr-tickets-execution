# Fresh Pi sessions for autonomous tickets

## Recommendation

Use a deterministic ticket scheduler to launch **normal interactive Pi processes in Herdr**, one fresh process per ticket. Keep scheduling state outside model conversations. Use a fresh Pi supervisor only when a decision needs reasoning.

This preserves the useful part of the course workflow: each ticket starts with the spec, ticket, repository instructions, and code, without the previous implementation transcript. A goal-driven dispatcher does not have to share the implementation's context window.

The scheduler is ordinary code, not a second AI harness. All reasoning and implementation sessions run in Pi.

## What I tested here

Installed versions: Pi 0.85.1 and Herdr 0.8.2.

| Experiment | Result |
| --- | --- |
| Start Pi through `herdr agent start --kind pi` | Normal TUI, with default model, tools, packages, skills, and project instructions |
| Close one test tab and launch a new Pi | Different PID and session ID; zero initial conversation-history entries |
| Give the first session a nonce, then ask the second for it | Second session answered `NO_PRIOR_CONTEXT`; its first context contained only its own user message |
| Invoke a slash prompt template through Herdr | Expanded before the model call |
| Run the scripted two-session sequential test | Passed |
| Run two Pi turns concurrently | Passed; recorded run intervals overlapped |
| Preserve saved sessions after closing test tabs | Session JSONL paths retained |
| Python validation tests | 10 passed |
| Typecheck the observer against the installed Pi API | Passed |

Successful smoke requests used about 9,000 current-context tokens each with this installation's normal resources. That is a startup measurement, not a prediction for implementation tasks.

The initial parallel run exposed `agent_pane_busy`: creating a tab does not mean its shell has finished starting. The runner preserved the failed tab. After inspection, I added shell-startup checks and repeated the test successfully. Herdr's `agent start` is still the final readiness authority; the preliminary shell check is not a universal prompt detector.

The first observer version also read its CLI flag too early, during extension initialization. It now reads the flag from event handlers. The session was restarted before collecting freshness evidence.

See [evidence.json](evidence.json) for session IDs, results, and local evidence paths. No real ticket was implemented, no GitHub issue was changed, and no concurrent code writers were tested. Only test tabs created during this experiment were closed. Existing application changes were left alone.

## Reproduce the smoke test

Run inside a Herdr-managed terminal in a trusted project:

```sh
# Two fresh sessions, one after the other
python3 experiments/pi-herdr-tickets/smoke.py --jobs 1

# Two fresh sessions with concurrent model turns
python3 experiments/pi-herdr-tickets/smoke.py --jobs 2

# Leave successful test tabs open for inspection
python3 experiments/pi-herdr-tickets/smoke.py --jobs 2 --keep

# No model calls or Herdr commands in these unit tests
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s experiments/pi-herdr-tickets -p 'test_*.py' -v
```

The live tests make model requests and use your normal Pi authentication. They ask Pi not to call tools; they do not sandbox it or remove its normal tools. Run them only with trusted project resources. If startup needs a trust decision, the test stops for inspection rather than approving it.

Files:

- `smoke.py` creates tabs, launches Pi, submits harmless prompts, validates evidence, and closes successful test tabs.
- `observe.ts` records session identity, initial context, loaded resources, lifecycle events, and current context usage. It does not change the model's system prompt or tool set.
- `ticket-smoke.md` is an explicitly loaded test prompt template, not an implementation skill.
- `test_smoke.py` exercises smoke-validation failures.

The runner prints a private temporary evidence directory. It keeps failed panes and writes `state.json` with their identities. It does not automatically resume interrupted runs. Saved Pi sessions remain in the normal session store and can be opened with `pi --session <saved-path>`.

These are research tools, **not a production ticket runner**. The smoke answer check must never be reused as a ticket acceptance gate.

## The production design

```text
Approved ticket list + dependency graph + acceptance policy
                          |
                 Deterministic scheduler
                 Durable state and locks
                          |
           +--------------+--------------+
           |                             |
    Herdr tab / Pi A               Herdr tab / Pi B
    Fresh TUI session              Fresh TUI session
    Ticket A worktree              Ticket B worktree
    /skill:implement URL           /skill:implement URL
           |                             |
           +---- candidate results ------+
                          |
           Independent tests and fresh reviews
                          |
               Serialized integration gate
                          |
            Mark accepted, then select next
```

A Pi extension can expose commands such as `/tickets start`, `/tickets status`, `/tickets pause`, and `/tickets resume`. These names describe the proposed interface; they are not installed by this experiment.

The extension should be a client for a persistent local scheduler process. Closing or clearing the chat that started the batch must not erase the batch's state. Use SQLite transactions or another atomic store, not the parent model's memory. Show progress through UI status or custom entries, without injecting every event into the parent's LLM context.

### 1. Admit and claim work

Start with an explicitly approved set of tickets, not every open issue. Pin the GitHub repository, spec reference, issue body/version, base branch, permitted commands, and acceptance policy.

Compute the ready set in code. Select tickets whose dependencies have been accepted and whose changes are available on the integration base. A closed GitHub issue alone does not prove its implementation is present locally.

Claim each ticket with an atomic local lease before launching a worker. A GitHub assignee or label is useful for visibility but is not a sufficient distributed lock. Record an attempt ID and prevent two workers from claiming the same issue.

Unknown dependencies, cycles, changed specs, and ambiguous requirements pause the affected work. They do not authorize a model to invent the missing requirements.

### 2. Launch an ordinary Pi session

Herdr provides the necessary primitives:

```sh
herdr tab create --workspace "$HERDR_WORKSPACE_ID" \
  --cwd "$WORKTREE" --label "ticket-42" --no-focus

# Read the returned root_pane.pane_id, and wait for shell startup.
herdr agent start ticket-42 --kind pi --pane "$PANE" --timeout 60000

# Only after interactive readiness and command preflight:
herdr agent prompt ticket-42 \
  '/skill:implement https://github.com/OWNER/REPO/issues/42' \
  --wait --timeout 1800000
```

Parse returned IDs. Do not derive them from sidebar positions. The smoke runner contains the executable version of this launch sequence.

Do not pass `--continue`, `--resume`, `--fork`, or an old `--session`. Do not disable extensions, skills, context files, or persistence to make the worker easier to launch. Use the normal configuration and authentication. A new process uses configured defaults, not unsaved model changes in the originating chat; pin the desired model explicitly if necessary.

These are ordinary root Pi sessions, not restricted `pi-subagents` workers. You can focus their tabs, type steering messages, inspect `/session`, or resume them later. They can use their normal review tools and extensions.

A worktree can require a separate project-trust decision and dependency installation. Resolve that during admission, not by silently disabling trust or omitting project instructions.

### 3. Resolve `/implement` correctly

This installation currently has neither an `implement` skill nor an `/implement` command. It also lacks the course's `tdd` and `code-review` skills. The course command cannot be assumed to work yet.

Pi's native skill command is `/skill:implement`. To retain the course spelling, register a small `/implement` alias that checks the skill is available and calls:

```ts
pi.sendUserMessage(`/skill:implement ${args}`, {
  expandPromptTemplates: true,
});
```

The expansion option matters for extension-injected messages. Sending the text through Herdr's normal editor uses normal interactive dispatch.

The alias should fail visibly when the skill is missing. The scheduler should query a worker-side preflight endpoint backed by `pi.getCommands()` and verify command provenance before submitting work. Do not treat an unrecognized slash string as a successful invocation.

Adapt the course skills for Pi, including the review orchestration, rather than copying Claude-specific tool names. Keep tracker closure and integration under scheduler ownership so an implementation worker cannot unblock successors just by closing an issue.

### 4. Separate idle from accepted

Use a state machine such as:

```text
planned -> claimed -> starting -> running -> candidate
        -> verifying -> reviewing -> integrating -> accepted

Any stage -> needs_attention
```

Herdr `idle` or `done` is a lifecycle signal. It is not an acceptance signal. `done` is essentially idle background work the user has not viewed; focusing the tab can change its presentation.

Use Pi's `agent_settled`, not `agent_end`, for lifecycle reporting. `agent_end` can precede retries, compaction recovery, or queued follow-ups. Even `agent_settled` does not prove that external jobs or detached reviewers are finished.

Add a worker result tool or command that submits a bounded candidate receipt containing:

- Attempt ID, issue identity, and spec version.
- Pi session ID and artifact references.
- Claimed outcome: ready for verification, blocked, or needs splitting.
- Review run references and unresolved findings.

The scheduler records the actual worktree, base commit, candidate commit, and diff itself. Bind checks and review reports to that exact commit. A later fix invalidates stale evidence.

Run approved test/typecheck commands outside the implementation model's discretion and retain exit codes and logs. Collect separate fresh-context standards and spec reviews. Require a bounded fix/recheck loop and verify all review jobs have finished before accepting the ticket.

A passing test suite is not proof of full spec compliance or UI quality. Define browser checks and human QA requirements in the acceptance policy. Do not mark a ticket fully accepted if required QA is outstanding.

Only after acceptance and successful integration should the scheduler update GitHub, release dependents, and optionally close the worker tab. Keep failed workers and worktrees available for inspection. Never infer success from a summary saying "implemented, reviewed, committed."

### 5. Protect the supervisor's context

Routine scheduling requires **zero model tokens**. The full batch can grow to hundreds of tickets without enlarging a model conversation.

When reasoning is necessary, start a fresh supervisor Pi session with a small decision packet: the current ticket, relevant dependency states, bounded findings, and links to evidence. Give it one decision, not the entire batch history. Store the decision and end that session. Do not resume one supervisor indefinitely while appending every worker report.

A supervisor should not be able to waive required checks, approve destructive operations, or expand scope beyond the batch policy. Those cases go to the human.

### 6. Bound each implementation session too

Freshness between tickets does not prevent a single oversized ticket from exhausting context.

Track `ctx.getContextUsage()` and elapsed time. Choose per-model soft and hard operating budgets with headroom for reviews and a checkpoint. Treat thresholds such as 150k as heuristics, not established universal limits. Cumulative token expenditure is different from the tokens currently in the context window.

At the soft limit, request a bounded checkpoint. If the ticket remains too large, preserve the worktree and mark it `needs_split` or `needs_attention`. A fresh replacement can re-read the ticket, code, diff, and explicit handoff, but that is an intentional recovery, not silently calling an unfinished ticket complete.

Usage reporting includes estimates and cannot prevent every overshoot, especially a huge tool result. Bound tool output, check usage before further work, and do not kill a process in the middle of a file mutation merely because a counter crossed a threshold. Record any compaction; do not quietly relabel a compacted continuation as a fresh ticket session.

### 7. Parallelize only safe work

Start the first production version with concurrency one. Then admit independent tickets concurrently when they have:

- Different worktrees and branches.
- Separate database files, app ports, and other mutable runtime resources.
- Dependencies already integrated into their base.
- Enough provider quota and a bounded total worker count.

No dependency edge does not guarantee no conflict. Two independent tickets may both change schema, migrations, package locks, or a shared API.

Serialize integration. If another ticket changes the base, update the candidate as needed and rerun integration-sensitive checks. Merge conflicts and new review findings pause integration. Do not solve collisions by running multiple writers in the same checkout.

The experiment's shared-cwd parallel test was safe only because both prompts prohibited tools and the evidence confirmed no tool calls. It does not validate parallel implementation or merging.

### 8. Fail safely and recover explicitly

Persist tab, pane, session ID, session path, worktree, branch, base commit, attempt ID, and stage. Reconcile these on scheduler restart before launching anything new.

- Missing observer handshake, launch error, provider failure, or unknown state: stop and retain evidence.
- A Pi question may appear as idle rather than blocked. Absence of an accepted receipt still prevents advancement.
- Test blocked-state integration explicitly. The installed Herdr extension handles its `herdr:blocked` bus signal; not every possible question UI is proven covered by this experiment.
- A timeout is not a failed ticket and does not prove the worker exited. Reconcile before retrying.
- On human takeover, pause automation for that worker so the scheduler does not race the user's edits or close their active tab.
- Before control or cleanup, validate the current occupant and session identity. Never target an unrelated focused pane.
- Make integration and GitHub updates idempotent, including recovery after an operation succeeded but the response was lost.

The smoke runner has only bounded waits and diagnostic state, not these production recovery guarantees. In its parallel mode both already-started smoke attempts finish independently; it has no general batch cancellation system.

Pi's normal tools and extensions have your account's permissions. An in-process result tool is a coordination mechanism, not a security boundary against a malicious worker. Strong enforcement needs protected CI or a sandbox with restricted credentials. Do not automatically execute arbitrary untrusted issue content.

## What to build next

1. Install and adapt `implement`, `tdd`, and `code-review`, with a small real acceptance test.
2. Build the serial scheduler, worker preflight/result bridge, durable leases, and verification/review gates.
3. Add the Pi `/tickets` control extension and safe restart/takeover handling.
4. Test a short dependency chain in an isolated repository, including failures and context-budget stops.
5. Add parallel worktrees and serialized integration only after the serial path is reliable.

This solves the context problem without assuming better auto-compaction. The remaining work is reliable acceptance and recovery, not opening terminal tabs.

## Sources

The installed CLI and Pi documentation were the authority for the experiments.

- [Herdr agent automation](https://herdr.dev/docs/agent-automation/)
- [Herdr CLI reference](https://herdr.dev/docs/cli-reference/)
- [Pi README and interactive sessions](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/README.md)
- [Pi extensions and lifecycle APIs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi skill invocation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/skills.md)
- [Pi prompt templates](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/prompt-templates.md)
- [Pi session persistence](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)

Local Pi docs: `/home/vscode/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/`.
