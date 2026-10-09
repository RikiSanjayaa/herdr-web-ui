# Domain docs

How engineering skills consume this repository's domain documentation.

## Before exploring

Read:

- `GLOSSARY.md`
- Relevant ADRs under `docs/adr/`

If either is absent, proceed silently. Domain-modeling skills create them lazily when terms or decisions are resolved.

## Layout

This is a single-context repository:

- `GLOSSARY.md` defines project domain language.
- `docs/adr/` records system-wide architectural decisions.

## Vocabulary

Use terms as defined in `GLOSSARY.md` in issue titles, specifications, plans, tests, and implementation discussions.

If a needed concept is absent, reconsider whether it is project-specific. Record a genuine vocabulary gap through the domain-modeling workflow.

## ADR conflicts

Surface any proposal that contradicts an accepted ADR. Do not silently override an existing decision.
