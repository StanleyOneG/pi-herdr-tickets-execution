# Pi Herdr controller

A Git-installable Pi package for preparing a fixed, reviewable ticket batch, durably controlling approved ticket attempts, and accepting exact candidates through serialized batch integration. The package includes a detached local controller daemon, private IPC client, production Git and Herdr/Pi adapters, independent gate execution, attempt-bound lifecycle/review/decision bridges, and Pi dashboard commands. Acceptance never updates or closes tracker issues, mutates a parent spec, repairs conflicts automatically, or merges a final delivery request.

## Runtime support

The preparation extension requires:

- Linux, macOS, or a compatible Linux devcontainer
- Node.js 22.19.0 or newer (the minimum required by Pi 0.85.1)
- Pi `>=0.85.1` with active `read`, `bash`, `herdr_get_preparation`, `herdr_submit_batch_proposal`, and `herdr_approve_batch` tools
- Herdr `>=0.8.2` available as `herdr`
- a Git repository with a branch and at least one commit
- a trusted Pi project
- a selected, authenticated Pi model with a viable context window
- the installed native skill commands `/skill:implement`, `/skill:tdd`, `/skill:code-review`, and `/skill:handoff`
- a loaded project instruction chain that explains the project's tracker workflow; Pi-loaded repository files and applicable ancestor `AGENTS*`/`CLAUDE*` files are accepted, while unrelated context files are not

Preparation uses the model and thinking level effective in the current Pi session. If no session override was selected, these are Pi's global defaults. It never substitutes another model when the selected model or its authentication is unavailable.

Project trust is an input-loading guard, not a sandbox. Pi extensions and model tools run with the local user's permissions. Use an OS/container boundary for untrusted unattended work; see Pi's security documentation.

## Install from Git

Review the source, then install a pinned tag or commit explicitly:

```sh
pi install git:github.com/StanleyOneG/pi-herdr-tickets-execution@<tag-or-commit>
```

A project-scoped install is also supported after the project is trusted:

```sh
pi install -l git:github.com/StanleyOneG/pi-herdr-tickets-execution@<tag-or-commit>
```

Restart Pi after installation. Pi discovers `src/extension.ts` from the package manifest. The package contains no replacement skills, shorthand skill aliases, machine-specific resource paths, or automatic updater. Upgrades are explicit:

```sh
pi install git:github.com/StanleyOneG/pi-herdr-tickets-execution@<new-tag-or-commit>
```

## Prepare and approve

Start a normal interactive Pi session in the execution project. Select the desired model and thinking level first if you do not want the saved Pi defaults.

```text
/herdr-prepare <spec-reference>
```

Pi asks for an editable readable controller name. Admission then checks Git identity, trust, Pi and Herdr capability, active tools, native skills, selected-model availability, and authentication before writing any preparation state.

The command starts a reasoning turn in the same normal Pi session. That turn is instructed to:

1. read Pi's loaded project instruction chain;
2. find and follow the project's human-readable tracker instructions;
3. retrieve only the selected spec and relevant tickets, including comments, dependencies, claims, tracker versions, canonical references, retrieval times, and content digests;
4. interpret optional checks from the project's coding standards;
5. plan safe setup and isolation for dependencies, environments, databases, ports, and external resources; and
6. call `herdr_submit_batch_proposal` with structured data.

The extension does not hardcode GitHub as an execution tracker. GitHub, GitLab, local files, or custom tracker tools work only when the project's instructions and the selected model's available tools explain how to use them.

A valid preview freezes:

- canonical project, tracker, spec, and ticket identities;
- one unique source-evidence registry containing version/content evidence and canonical references for instructions, requirements, external prerequisites, and check policy; proposal fields may deliberately reuse an evidence identity without duplicating its evidence record;
- explicit ticket claim status (`claimedBy` is the readable claimant or `null` only after verifying the ticket is unclaimed) and dependency graph;
- target branch and base commit;
- selected model, thinking level, and context window;
- concurrency, context reserve, handoff and repair limits;
- required standards/spec reviews and implementation-skill testing;
- optional check commands and constrained setup operations (dependency installation or public environment templates); and
- runtime resource isolation.

Missing or changed references, duplicate evidence identities or canonical references, missing/unreferenced evidence records, dependency cycles, duplicate ticket identities, unresolved external prerequisites, ambiguity, unknown/unsafe resources, non-template environment copying (including `.env.local`), any automated database setup, and unsafe parallel sharing reject the proposal. Setup is structured rather than accepted as model-labelled arbitrary shell: dependency installs name a package manager and mode, and environment setup copies only explicit `.example`/`.sample`/`.template` sources within the worktree. Database scripts are not approvable in this slice because a `test` label does not prove what a package script executes; use an already isolated nonproduction database resource or request clarification.

Inspect durable state without invoking a model:

```text
/herdr-status
```

Approve a proposed preparation by ID:

```text
/herdr-approve <preparation-id>
```

This asks the reasoning session to re-read all approved sources through the configured tracker workflow. The controller compares the exact current source set, tracker versions, content digests, canonical references, Git base, model, thinking level, and proposal digest. Revalidation must have a newer retrieval timestamp; an equal or older timestamp is stale. New tickets, changed requirements, changed instruction/check evidence, or changed scope invalidate approval. The approval request carries the digest loaded before the UI prompt; the final durable approval rejects the request if another proposal was submitted while Pi awaited the author or confirmation. Only after validation does the extension present that exact frozen preview and ask for explicit approval and attribution. Approval is written atomically before success is reported.

Preparation and approval never invoke `/skill:implement`, start a Herdr process, modify tracker state, or create an execution attempt.

## Durable execution controller interface

`PreparationController` preserves the preparation API and adds one capability-gated execution and acceptance seam:

- `startTicket`, `attachAttempt`, `pauseAttempt`, and `resumeAttempt`;
- `takeOverAttempt` and `returnAttempt`;
- `answerDecision` and `recordWorkerObservation`;
- `captureCandidate` and `acceptCandidate`;
- `controllerRestarted`; and
- the existing cursor-bounded `status`, now including bounded execution attempts, decisions, diagnostics, session identities, and artifact references.

Callers inject `GitWorktreePort` and `WorkerRuntimePort`. The production daemon composes `RealGitWorktreeAdapter`, `LocalSetupRuntime`, and `HerdrWorkerRuntime`. The worker port deliberately separates durable tab/pane allocation from Pi startup so allocation ownership can be persisted before readiness waits and dispatch.

A start is keyed by approved preparation and ticket identity. The claim and deterministic worktree plan are persisted before Git or worker side effects. Repeated starts return that durable attempt. Tickets with in-batch prerequisites remain blocked because this controller does not treat worker completion as acceptance. The real Git adapter creates a dedicated `herdr/ticket-*` branch under a sibling `.<repository>-herdr-worktrees/` directory, rejects redirected worktree roots, then verifies the worktree's top level, common Git directory, HEAD, branch, and `git worktree list --porcelain` ownership.

The original checkout baseline includes HEAD, branch, status, binary index/worktree diff digests, and content digests for changed and untracked paths. Automated controls and monitored worker observations recheck that baseline plus worktree and worker ownership. The worktree's approved base remains immutable provenance while its candidate HEAD advances through normal implementation commits; the candidate must stay on the owned branch and descend from that base. A mismatch enters `needs-attention`; the controller never stashes, resets, cleans, removes, or closes preserved work. These checks are detection guardrails, not an OS sandbox.

`HerdrWorkerRuntime` creates an unfocused tab in the approved workspace and worktree, persists the returned tab and pane through the controller, waits for shell output, and polls `pane process-info` until the shell owns the foreground process group. It then uses `agent start --kind pi` to launch a named ordinary interactive Pi TUI with the approved `provider/model` and thinking level. It passes only the additive package worker bridge extension: it does not select print/JSON/RPC mode, resume/fork an old session, disable saved sessions, or disable normal tools, extensions, skills, prompts, context files, settings, authentication, or instructions.

Before implementation dispatch, the runtime sends the non-model `/herdr-worker-ready` extension command and waits on an attempt-specific file channel. The receipt proves a fresh startup and zero initial conversation history, TUI mode, PID, Herdr workspace/tab/pane, saved Pi session ID/path, actual cwd, exact model/thinking/context window, active tools, loaded context files, and native skill command provenance. The runtime joins that proof to `agent get` ownership and the saved-session path reported by Herdr, then submits exactly `/skill:implement <approved-ticket-reference>` without waiting for the implementation turn to finish. A successful submission acknowledgement is persisted before `startTicket` returns; an error or timeout remains ambiguous and is never retried by the adapter. The daemon subsequently monitors the exact owned worker and Git guardrails in short serialized updates, leaving pause, takeover, and decision delivery available during the active turn. Each external monitor sample is bound to the durable control generation captured before the await, so pause, resume, takeover, return, restart, and decision transitions invalidate stale results. A monitor failure is sanitized and recorded per attempt only after the same Git guardrails run. It revalidates the exact owned pane and saved session before later prompts or focus. All command calls use argument vectors.

The file bridge transport is constructed with a daemon-owned absolute directory. It creates a unique nonce-bound channel and expects `HERDR_WORKER_BRIDGE_ENDPOINT`, `HERDR_WORKER_BRIDGE_NONCE`, and `HERDR_WORKER_BRIDGE_AGENT_NAME` to reach the Pi process through `herdr tab create --env`. The worker writes a bounded `0600` JSON receipt in that restrictive directory; the runtime consumes it once. These interfaces are intentionally transport-narrow so the daemon can own the directory and adapter lifecycle without becoming part of the Pi extension process.

Dashboard/client disappearance has no lifecycle effect. An explicit controller-process restart moves executing attempts to `restart-required` without worker action; explicit resume performs minimal Git and worker ownership checks. If restart interrupts startup before an acknowledged implementation dispatch, resume fails closed because a timeout or lost response cannot prove whether the prompt was received. Comprehensive reconciliation and relaunch remain recovery work. Pause and takeover prohibit automated delivery until explicit resume or return. Worker `idle`, `done`, successful dispatch, and completion prose can produce only `completed-unaccepted`, never acceptance, and cannot hide an unresolved local decision.

## Fresh reasoning and context handoffs

After approval, start batch supervision from a Pi session in the intended Herdr workspace:

```text
/herdr-orchestrate <preparation-id>
```

The daemon launches a fresh normal Pi TUI as the reasoning orchestrator, using the approved model and thinking level. It receives a bounded decision packet with spec/ticket references, source revisions, batch state, current workers, decisions and evidence links. It does not receive prior transcripts. The model selects work and submits `start`, `assess`, `escalate` or `wait` through `herdr_orchestrator_operation`. `assess` captures the exact candidate and resolves the worker-owned native evidence before using the existing acceptance gate. There is no operation to waive a gate, change scope or policy, or merge a final PR/MR.

Completion and blocking fence the old orchestrator generation immediately. Once its Pi session has settled with no executing tools, queued messages or external jobs, the daemon retires it and launches a fresh reasoning session. Active ticket workers and outstanding questions stay intact. Current-context exhaustion also triggers this role-preserving rotation. The last persisted assessment and current supervisory state form the checkpoint; speculative reasoning not submitted to the controller is not carried forward. Routine rotation is not a daemon restart. After a daemon restart, `/herdr-orchestrate` explicitly resumes supervision, while ticket attempts still require their own explicit resume.

`/herdr-status` shows the orchestrator phase, current occupancy, compactions and batch questions. Answer a batch question with:

```text
/herdr-batch-answer <preparation-id> <decision-id> <answer>
```

The first explicit answer and its author are durable. Recording or dispatching an answer does not prove that the model applied it. Worker-specific questions continue to use `/herdr-answer`.

Managed sessions report Pi's current context estimate, not billed token totals. The effective trigger is the minimum of the requested limit, 190,000 tokens, and the model window minus its reserve. The reserve is at least 20,000 tokens or ten percent of the window. Admission rejects an operating budget that cannot exceed its reserve. At the limit, a bridge guard stops new tools at a tool boundary. Existing tools and external jobs must settle before retirement. Missing usage at a safe boundary raises a decision rather than claiming a reserve guarantee. Compactions remain recorded in the saved Pi session and reported in occupancy snapshots; they are not fresh sessions.

For implementation workers, the controller explicitly dispatches `/skill:handoff` with the ticket, worktree and current Git code-state bindings. The native skill chooses its filename. The worker then calls `herdr_submit_handoff` with the actual Markdown path. The bridge requires a native handoff invocation and a bounded document containing those bindings, changes, checks, findings, decisions and next steps. The daemon verifies the receipt and file digest, retains a redacted private copy beside the durable worker bridge state, then verifies safe retirement. Only after the old process is gone can a new Pi TUI start in the same worktree with `/skill:implement`, the ticket and durable handoff reference. Dirty code is neither reset nor discarded.

A ticket has at most two context-driven replacements across controller restarts. The controller persists the counter before replacement startup. Missing artifacts, changed code, ambiguous dispatch, unsafe retirement or an exhausted limit preserve work and raise a decision. Interrupted handoffs require investigation or manual takeover; an answer cannot reset the replacement counter or silently retry an ambiguous launch.

Decision packets are capped at 32 KB and handoff documents at 24 KB. Oversized packets stop supervision for human scoping rather than silently dropping decisions. Detailed logs and saved conversations stay outside routine model input and can be inspected on demand. These limits are best-effort safeguards: provider estimates, a single large result, or concurrent tool output can overshoot a threshold. They do not guarantee exact timing or model quality.

The additional file handling uses bounded regular-file reads, SHA-256 content bindings and private atomic writes. Handoff copies redact common credential formats; no credentials or certificates are added to the package. This remains a trusted-local-user controller, not an OS sandbox or a guarantee that arbitrary prose contains no secrets.

## Detached daemon and private client

Every installed preparation command and tool connects to the same project daemon before reading or writing controller state. If no daemon answers, `connectOrStartLocalController(statePath)` launches `pi-herdr-controller --state <absolute-state-path>` as a detached Node process and waits for its authenticated Unix socket. The executable loads TypeScript through the package's runtime `tsx` dependency, so it runs outside Pi's extension loader in a production-only package install.

The daemon is the only holder of the controller actor capability and the only state writer. A `0600` ownership record plus the exclusive Unix socket prevents a second daemon from serving the project; all controller mutations are serialized inside that process. Each authenticated request is checked for exact method arity and nested payload shape before dispatch. Each stateless client request uses a random `0600` token in a `0700` runtime directory. The socket lives in the current user's private runtime/temp directory under a state-path digest, avoiding Unix socket path-length problems and cross-project collisions. Client exit or socket disconnect has no cancellation meaning.

The exported `ControllerClient` methods are:

```text
prepare(request, admission)
submitProposal(preparationId, proposal)
validateApproval(preparationId, request)
approve(preparationId, request)
preview(preparationId)
getPreparation(preparationId)
status(pagination)
startTicket(request)
attachAttempt(request)
pauseAttempt(request) / resumeAttempt(request)
takeOverAttempt(request) / returnAttempt(request)
answerDecision(request)
recordWorkerObservation(request)
captureCandidate(request)
acceptCandidate(request)
```

On every daemon-process start, previously executing attempts move to `restart-required` without any Git, Herdr, Pi, or model action. Only an explicit `resumeAttempt` or `returnAttempt` can continue automation, after the controller rechecks exact Git and worker ownership. A startup or dispatch whose result is ambiguous remains non-executing and requires later recovery rather than an inferred retry.

Before worker allocation, the daemon executes only setup operations frozen in the approved proposal. It persists each exact operation digest before the side effect and a bounded outcome digest afterward. Supported operations are package-manager dependency installation in the approved regular/frozen mode and exclusive copies from approved public environment templates. Database setup remains rejected. A failure or lost response becomes `needs-attention`; setup is never guessed or retried.

The worker bridge also registers `herdr_request_local_decision`. A worker supplies a bounded question, context, options, and recommendation to a nonce-bound private file channel and waits without a second model turn. The daemon validates current worker ownership, records the question in controller state, and only then acknowledges the bridge request. An explicit client answer is persisted before the runtime writes the exact answer back to the waiting tool. Pause and takeover retain answers without delivery until explicit resume or return.

## Execution dashboard

Run execution commands from a normal interactive Pi session in the approved project. Starting a ticket requires that Pi itself is running in the target Herdr workspace so `HERDR_WORKSPACE_ID` identifies the workspace to the daemon:

```text
/herdr-start <preparation-id> <approved-ticket-identity>
/herdr-accept <attempt-id>
/herdr-status
/herdr-questions [attempt-id]
/herdr-attach <attempt-id>
/herdr-pause <attempt-id>
/herdr-resume <attempt-id>
/herdr-takeover <attempt-id>
/herdr-return <attempt-id>
/herdr-answer <attempt-id> <decision-id> <answer>
```

`/herdr-status` shows a bounded, human-readable page of preparation and attempt lifecycles, exact worktree/Herdr/session references, artifacts, diagnostics, and unresolved decisions. It updates a Pi footer status and widget and uses local UI notifications; routine controller events are not appended to the model conversation. `/herdr-questions` narrows that view to unresolved questions with their context, options, and recommendation. `/herdr-answer` asks for answer attribution, then records the first explicit answer durably before the daemon attempts delivery.

`/herdr-attach` validates Git and exact worker ownership through the daemon and focuses the owned Herdr agent without changing automation state. It also prints the non-takeover `herdr agent attach <owned-name>` command for a separate terminal. `/herdr-takeover` first durably pauses automation for that attempt, focuses the exact worker, and prints `herdr agent attach <owned-name> --takeover`; automation stays paused until `/herdr-return`. `/herdr-pause` is a durable automation pause, not a promise that an already-running model turn was killed. Resume and return recheck current Git, pane, process, and saved-session ownership before delivering any retained answer.

`/herdr-accept` first asks the daemon to capture a stable candidate receipt from actual Git state. Capture includes the immutable source base, HEAD/branch, staged and unstaged diff digests, status, untracked-file content fingerprints, a final-filesystem Git code-state digest, proposal/spec revision, batch/ticket/attempt/session identities, and existing artifact references. The code-state digest is deliberately independent of HEAD and staging placement, so review-before-commit evidence remains usable after a content-equivalent commit while changed content is rejected. Capture succeeds only after the exact worker reports Pi's `agent_settled` lifecycle with no observed outstanding Pi tools or queued messages; Herdr `idle`/`done`, prompt success, or completion prose alone is insufficient.

The live worker bridge observes Pi's execution result for a directly invoked native test command and native subagent reviews. Foreground reviews use structured no-blocker acceptance metadata. The installed subagent extension's ordinary asynchronous parallel code-review workflow is also supported: the bridge joins the host tool call to the extension's versioned start and completion events, requires two or more fresh `reviewer` sessions with unique identities and retained output artifacts, and accepts each artifact only when it ends with exactly one `Merge verdict: OK` or `Merge verdict: OK with notes` line. A `BLOCK` verdict, stale code state, replay, unrelated run, incomplete result, reused reviewer identity, or missing artifact fails closed. Output text, echo/printf, shell wrappers, chaining or status masking, informational help/version/list modes, collect-only/no-run/dry-run modes, and typecheck/lint alone do not count as test success. A later failed test or blocking review invalidates the corresponding earlier pass until that obligation passes again and revokes the public `latest.json` index without deleting immutable audit artifacts. When Pi settles with no outstanding work, the worker bridge automatically creates private producer receipts and manifests outside the repository only when both obligations match the unchanged current code-state digest; each receipt retains its Pi session and tool-call reference, and asynchronous review receipts also retain a digest-bound copy of each resolved reviewer report. The dashboard reasoning turn cannot capture or supply artifact paths to `herdr_accept_candidate`: that tool resolves the exact worker session's producer-owned index itself. The daemon opens only bounded nonblocking regular files, closes every handle, and validates both manifest and producer identity before integration; missing, changed, failed, oversized, nonregular, or candidate-mismatched evidence is rejected.

The daemon creates one dedicated `herdr/batch-*` integration worktree per preparation plus an isolated `herdr/stage-*` worktree per candidate. A persisted integration sequence and head serialize each application against the actual latest accepted batch HEAD independently of implementation concurrency. It applies committed, staged, unstaged, and untracked candidate changes, treating an untracked path that now exists on the accepted base as a conflict rather than overwriting it and rejecting symbolic-link ancestors before staging directories or copies are created. When source and staged code-state digests differ, a fresh normal Pi TUI using the approved model and installed implementation skill re-runs the project's existing native testing/review obligations without edit, repair, commit, fallback-command, or waiver authority. The bridge records the commands it actually observed, and any staging change during that verification blocks acceptance. Every optional approved check also executes independently in staging. Retained check logs contain exit/termination details, candidate/command/output digests, byte/line counts, and bounded allowlisted compiler codes, test counts, and failure types. Arbitrary free text, stack traces, payloads, and secrets are omitted and represented only by their digest and counts.

Separate fresh Pi TUI sessions perform Standards and Spec reviews against the staged commit and resolvable review base. A review receipt is accepted only after that exact Pi session settles with no observed outstanding work. The worker bridge consumes the installed subagent extension's public lifecycle events and bounded status RPC snapshot, traversing nested runs, steps, and external-provider children even when their parent is terminal; unknown, omitted, or incomplete asynchronous status remains an actionable outstanding job instead of being treated as completion. Before advancement, the controller rechecks the original checkout, ticket and staging Git state, exact implementation worker ownership, settled lifecycle, outstanding jobs, pending decisions, and the current persisted integration head. Long checks and reviews do not hold the controller mutation queue, so pause or takeover remains prompt and invalidates the in-flight acceptance lease. Before final fast-forward, the controller durably journals the exact from/to commits, worktree, receipt, and next sequence. After a restart, explicit resume accepts only that exact already-advanced commit or records that the unchanged branch did not advance; unrelated movement fails closed. Final fast-forward advancement disables project hooks. Only an unchanged, clean ticket worktree is eligible for owned-tab cleanup; integrated staged, unstaged, or untracked work remains open for investigation. A check/review/conflict/infrastructure failure records `integration-blocked`, leaves the prior accepted batch HEAD unchanged, and preserves source and staging worktrees.

An accepted in-batch prerequisite releases successors from the controller's dependency gate only while its recorded commit remains present on the owned batch branch. The implementation prompt includes that accepted-commit evidence even if the tracker issue remains open. The controller performs no tracker close operation.

Every dashboard operation uses `connectOrStartLocalController` and the authenticated `ControllerClient`. Closing the dashboard Pi process or terminal does not stop the detached daemon, cancel a worker, or erase a pending decision. A daemon-process restart is different: executing, `completed-unaccepted`, and preserved `integration-blocked` attempts receive the new owner and become `restart-required`; they remain non-executing until explicit resume. An attempt interrupted while `starting` retains its implementation-concurrency slot and cannot resume until its exact worker/dispatch effect can be reconciled. Resuming a completed or formerly blocked acceptance returns it to `completed-unaccepted` so its preserved candidate can be recaptured without guessing recovery work. Integration/recovery lifecycles do not consume implementation concurrency; actual running, paused/takeover, and restart-required implementation occupancy still obeys the approved cap and per-ticket ownership.

The original-checkout, worktree, cwd, pane, process, and session checks are detection guardrails only. Lifecycle observations additionally require a current nonce challenge answered by the originally recorded Pi PID, so a resumed replacement process cannot reuse an old lifecycle file. They do not restrict the local user's filesystem or credentials, prevent an unrestricted worker tool from bypassing checks, or provide an OS sandbox. A detected mismatch stops controller automation and preserves the checkout, worktree, tab, session, and evidence; the controller never stashes, resets, cleans, or discards them.

## Persistence and credentials

State is stored with mode `0600` under the repository's Git common directory:

```text
<git-common-dir>/herdr/controller-state.json
```

This works for ordinary repositories and linked worktrees without adding a tracked project file. Writes use a synced temporary file and atomic rename. Reads migrate legacy schema-v1 approved preparations that predate batch-integration metadata to their approved base at sequence zero, then validate every persisted preparation, nested proposal, execution attempt, identity, pending effect, and decision before returning data; malformed, inconsistent, oversized, or unsupported state fails closed with a sanitized storage Result. The schema remains version 1. To keep storage reads and collection queries bounded, one state file accepts at most 100 preparations, 100 attempts, and 5 MiB, and the public status interface requires opaque-cursor pagination with at most 50 records per page. Further preparation or execution is rejected explicitly at capacity; archive the state file only after retaining any approval and execution records you need. `/herdr-status` displays the first bounded page and reports when more records exist.

Proposal state stores model identity and authentication outcome only. Execution state stores bounded ownership, readiness, Git, decision, diagnostic, and reference evidence. Neither stores API keys, resolved headers, credential environment, or full model transcripts. Credential-looking infrastructure details are replaced with fixed diagnostics rather than persisted.

Back up the Git common directory if approved preparation records must survive repository loss. Restore it only with the matching repository and verify `/herdr-status` before relying on an approval.

## Development and validation

Tests use the controller's public preparation, proposal, approval, and status methods. They substitute runtime/tracker/model observations while using disposable real Git repositories and real on-disk persistence.

```sh
npm install --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run
pi -e . --list-models
```

`pi -e . --list-models` is a package-discovery smoke check; it makes no model request and does not test Herdr execution.

## Current limitations

- The durable controller, detached daemon/private IPC, real Git and constrained setup adapters, production Herdr/Pi runtime, Pi readiness/lifecycle/review/local-decision bridge, independent checks, serialized acceptance integration, and dashboard commands are implemented. The lifecycle bridge observes Pi agent, active tool, queue, and settled state exposed by Pi; it cannot detect a process deliberately detached by a worker after the launching tool has returned. Handoff replacement, automatic conflict repair, comprehensive recovery, final delivery requests, and Telegram routing are not yet wired.
- Tracker evidence is collected and content-digested by the reasoning session using project-provided prose instructions. The controller deterministically compares submitted identities, versions, content digests, canonical references, and retrieval ordering. This is an epistemic guard over the evidence the model supplied; it is **not** independent backend verification, because an arbitrary prose-defined tracker has no deterministic adapter here. Human approval must assess whether the evidence and references are credible.
- Authentication admission resolves the selected provider configuration without logging the result. It does not make an extra billable model probe; the preparation reasoning request remains the practical end-to-end provider check.
- The daemon enforces one local writer for supported clients. The private socket/token and ownership record are local-user controls, not authentication between mutually hostile processes running as the same OS account and not an OS sandbox.
- Public controller operations require an in-process capability held only by the daemon. Pi uses the private authenticated client and cannot assert an arbitrary actor capability; `approvedBy` remains audit attribution, not authentication. This does not add remote login or claim an OS sandbox.
- Platform declarations cover Linux and macOS. Native Windows is not supported.
