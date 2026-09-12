# Domain docs

## Layout and reading rules

This repo uses a single-context layout:
- `CONTEXT.md` at the repo root holds domain terminology.
- `docs/adr/` holds architectural decision records.

Before exploring the codebase, read `CONTEXT.md` and ADRs relevant
to the area you will work in.

If these files do not exist, proceed silently without suggesting
their creation upfront. `/domain-modeling`, also reached through
`/grill-with-docs` and `/improve-codebase-architecture`, creates them
when terms or decisions are resolved.

## Vocabulary

Use the glossary's terms in issue titles, proposals, hypotheses,
and test names. Respect any synonyms it explicitly avoids.

If a needed concept is missing, reconsider whether it belongs
or note the gap for `/domain-modeling`.

## ADR conflicts

Explicitly flag any proposal that contradicts an existing ADR.
Name the ADR and explain why the decision should be reconsidered.
