# Issue tracker: local Markdown

Issues and specs for this repo live as local Markdown files in `.scratch/`. The directory is excluded through `.git/info/exclude` and must never be committed.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Never create one combined tickets file
- Triage state is a `Status:` line near the top of each issue file
- Comments and conversation history append under `## Comments`

## Publishing

When a skill says "publish to the issue tracker", create the requested Markdown file under `.scratch/<feature-slug>/`.

## Fetching

When a skill says "fetch the relevant ticket", read the referenced `.scratch/` file. The user normally supplies its path or issue number.

## Wayfinding

- Map: `.scratch/<effort>/map.md`
- Child ticket: `.scratch/<effort>/issues/NN-<slug>.md`
- Ticket type: `Type: research|prototype|grilling|task`
- Ticket state: `Status: claimed|resolved`
- Dependencies: `Blocked by: NN, NN`
- Claim by setting `Status: claimed` before work
- Resolve by appending `## Answer`, setting `Status: resolved`, and recording the context pointer in the map
