# Pi Herdr controller

A Git-installable Pi package for preparing a fixed, reviewable ticket batch before Herdr execution. This release implements preparation and durable approval only. It does **not** launch implementation workers, integrate branches, update tickets, or mutate a parent spec.

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

## Persistence and credentials

State is stored with mode `0600` under the repository's Git common directory:

```text
<git-common-dir>/herdr/controller-state.json
```

This works for ordinary repositories and linked worktrees without adding a tracked project file. Writes use a synced temporary file and atomic rename. Reads validate every persisted preparation and nested proposal before returning data; malformed, inconsistent, oversized, or unsupported state fails closed with a sanitized storage Result. The schema remains version 1, so existing valid state is preserved. To keep both storage reads and collection queries bounded in this preparation-only release, one state file accepts at most 100 preparations and 5 MiB, and the public status interface requires opaque-cursor pagination with at most 50 records per page. Further preparation is rejected explicitly at capacity; archive the state file only after retaining any approval record you need. `/herdr-status` displays the first bounded page and reports when more records exist.

Proposal state stores model identity and authentication outcome only. It does not store API keys, resolved headers, credential environment, or full model transcripts. Credential-looking substrings are redacted from admission diagnostics.

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

- Worker launch, worktrees, handoff, review execution, integration, dashboarding, recovery, and Telegram routing belong to later tickets and are not implemented here.
- Tracker evidence is collected and content-digested by the reasoning session using project-provided prose instructions. The controller deterministically compares submitted identities, versions, content digests, canonical references, and retrieval ordering. This is an epistemic guard over the evidence the model supplied; it is **not** independent backend verification, because an arbitrary prose-defined tracker has no deterministic adapter here. Human approval must assess whether the evidence and references are credible.
- Authentication admission resolves the selected provider configuration without logging the result. It does not make an extra billable model probe; the preparation reasoning request remains the practical end-to-end provider check.
- The preparation store assumes one local writer process. This ticket does not provide the persistent multi-process execution daemon or leases needed by worker execution.
- Public controller operations require an in-process capability held by the installed Pi extension. This prevents model-issued calls or unrelated in-process callers from asserting an actor name; `approvedBy` remains audit attribution, not authentication. It does not add remote login, authenticate other operating-system processes, or claim an OS sandbox.
- Platform declarations cover Linux and macOS. Native Windows is not supported.
