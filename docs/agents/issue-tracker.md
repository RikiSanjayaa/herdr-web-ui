# Issue tracker: local Markdown

Issues and specs for this repo live as local Markdown files in `.scratch/`. Add `.scratch/` to your local `.git/info/exclude` before creating tickets, or confirm another ignore rule is in effect. Never commit this directory.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Never create one combined tickets file
- Triage status is a `Status:` line near the top of each implementation ticket, using the values in `docs/agents/triage-labels.md`
- Ticket execution state is tracked separately via `State: open|claimed|resolved`
- Comments and conversation history append under `## Comments`

## Publishing

When a skill says "publish to the issue tracker", create the requested Markdown file under `.scratch/<feature-slug>/`.

## Fetching

When a skill says "fetch the relevant ticket", read the referenced `.scratch/` file. The user normally supplies its path or issue number.

## Wayfinding

Wayfinding tickets track architectural decisions rather than triage workflow items. They do not use triage labels:

- Map: `.scratch/<effort>/map.md`
- Child ticket: `.scratch/<effort>/issues/NN-<slug>.md`
- Ticket type: `Type: research|prototype|grilling|task`
- Ticket execution state: `State: open|claimed|resolved`
- Dependencies: `Blocked by: NN, NN`
- Claim by setting `State: claimed` before work
- Resolve by appending `## Answer`, setting `State: resolved`, and recording the context pointer in the map
