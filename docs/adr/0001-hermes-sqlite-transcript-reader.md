# Read Hermes transcripts directly from SQLite via bun:sqlite

The bridge reads Hermes conversation turns directly from its local SQLite database (`~/.hermes/state.db`) using `bun:sqlite` in read-only mode, rather than running CLI export subprocesses or converting databases to JSONL.

## Status

accepted

## Context

Existing agents supported by herdr-web-ui (Claude, Codex, omp, omo, gjc, pi) store conversation transcripts in JSONL files. Hermes stores session metadata and messages in an SQLite database (`~/.hermes/state.db`).

## Decision

Use Bun's built-in `bun:sqlite` with `readonly: true` to query `messages` and `sessions` tables directly in `server/hermes.ts`. Pagination uses bounded queries over message ID ranges (`WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?`).

## Consequences

- Avoids subprocess overhead and intermediate file writes during chat polling.
- Introduces no new dependencies.
- Hermes schema changes to `messages` or `sessions` must maintain backward compatibility in the query logic.
