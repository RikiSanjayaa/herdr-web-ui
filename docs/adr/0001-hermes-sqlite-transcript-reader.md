# Read bounded Hermes transcripts from the pane's SQLite store

Hermes stores conversation history in `state.db`, so the bridge reads that database directly with read-only `bun:sqlite` rather than running export subprocesses or creating intermediate JSONL files. The selected store belongs to the Hermes process in the pane: an explicit bridge override wins, then that process's `HERMES_HOME`, then the bridge default.

## Status

accepted

## Decision

`server/hermes.ts` queries the `messages` and `sessions` tables through one reader interface. Each transcript page is a contiguous segment capped at 100 rows and 16 MiB, even when that splits an exchange; large tool output is previewed in the page and read in full through its transcript-generation-scoped reference. Cursors and output references are valid only within the database generation that produced them.

A herdr session report is primary session evidence. A terminal breadcrumb is accepted only when its cwd matches and it was written during the current Hermes process's lifetime. SQLite availability, locking, corruption, and incompatible-schema failures make the native transcript unavailable so the chat can fall back to terminal scrollback; one malformed message is isolated instead of invalidating the page.

## Consequences

- Polling cost is bounded for long autonomous exchanges.
- Multiple Hermes profiles on one machine resolve to the store used by each pane.
- A page may begin with assistant or tool activity from an exchange that started on an earlier page.
- Hermes schema changes remain isolated in the reader. Unsupported schemas lose the native view but not the terminal fallback.
