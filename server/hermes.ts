import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

import type { ConversationMetadata, ConversationPart, ConversationTurn, HerdrPane } from "../shared/protocol.ts";
import { herdrRpc } from "./herdr/client.ts";
import { answerVersion, ConversationNotStarted, ConversationUnavailable, type ConversationPage, HistoryChanged, type RecognizedConversation } from "./conversation.ts";
import { toolSummary } from "./transcript-records.ts";
import { trimOutput } from "./tool-output.ts";

export interface HermesMessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  reasoning: string | null;
  timestamp: number;
}

/** Uses HERMES_HOME when set, otherwise the user's .hermes directory. */
export function defaultHermesHome(userHome?: string): string {
  return process.env["HERMES_HOME"] || join(userHome ?? process.env["HOME"] ?? "", ".hermes");
}

/** Locates the session database within the selected Hermes home. */
export function hermesDbPath(hermesHome = defaultHermesHome()): string {
  return join(hermesHome, "state.db");
}

/** Recognizes the Hermes executable, including Python launching its entrypoint. */
export function isHermesProcess(entry: { name?: string; argv0?: string; argv?: readonly string[] }): boolean {
  const binary = (entry.name ?? entry.argv0 ?? entry.argv?.[0] ?? "").toLowerCase();
  if (binary === "hermes" || binary === "hermes.exe" || binary.endsWith("/hermes") || binary.endsWith("\\hermes.exe")) return true;
  if (entry.argv && entry.argv.length > 1) {
    const first = (entry.argv[0] ?? "").toLowerCase();
    if (first.includes("python") || first.endsWith("py")) {
      return entry.argv.slice(1).some((arg) => {
        const lower = arg.toLowerCase();
        return lower === "hermes" || lower === "hermes.exe" || lower.endsWith("/hermes") || lower.endsWith("\\hermes.exe");
      });
    }
  }
  return false;
}

/** Resolves process terminal identity to Hermes breadcrumb filename convention. */
export function hermesTerminalId(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const tty = readlinkSync(`/proc/${pid}/fd/0`);
      if (!/^\/dev\/(?:pts\/\d+|tty[\w-]+)$/.test(tty)) return null;
      return `tty-${tty.slice(1).replaceAll("/", "-")}`;
    }
    if (process.platform === "darwin") {
      const output = execFileSync("ps", ["-p", String(pid), "-o", "tty="], {
        encoding: "utf8", timeout: 1500, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!output || output === "??") return null;
      const device = output.startsWith("/dev/") ? output.slice(5) : output.startsWith("ttys") ? `dev-${output}` : output;
      return `tty-${device.replaceAll("/", "-")}`;
    }
  } catch { /* process exited or terminal unavailable */ }
  return null;
}

/** Reads a terminal's reported session, refusing a breadcrumb from another cwd. */
export function hermesBreadcrumbSession(home: string, terminalId: string, cwd: string): string | null {
  try {
    const marker = join(home, "terminal-sessions", terminalId);
    if (!existsSync(marker)) return null;
    const text = readFileSync(marker, "utf8");
    const data = JSON.parse(text) as { session_id?: unknown; cwd?: unknown };
    if (typeof data.session_id !== "string" || !data.session_id) return null;
    if (typeof data.cwd === "string" && data.cwd !== cwd) return null;
    return data.session_id;
  } catch {
    return null;
  }
}

/**
 * Resolves the Hermes session ID for a pane.
 * Checks Herdr agent.get report first, then falls back to terminal breadcrumbs.
 */
export async function hermesTranscriptForPane(
  pane: HerdrPane,
  cwd: string,
  hermesHome = defaultHermesHome(),
): Promise<{ sessionId: string; dbPath: string }> {
  const paneId = pane.pane_id;
  let sessionId = typeof pane.agent_session?.value === "string" && pane.agent_session.value.length > 0
    ? pane.agent_session.value
    : null;

  if (sessionId === null) {
    const info = await herdrRpc<{ agent: { agent_session?: { value?: unknown } } }>(
      "agent.get",
      { target: paneId },
    ).catch(() => null);
    if (typeof info?.agent?.agent_session?.value === "string" && info.agent.agent_session.value.length > 0) {
      sessionId = info.agent.agent_session.value;
    }
  }
  if (sessionId === null) {
    const processInfo = await herdrRpc<{
      process_info?: { foreground_processes?: { pid: number; name?: string; argv0?: string; argv?: string[] }[] };
    }>("pane.process_info", { pane_id: paneId }).catch(() => null);

    const hermesProc = (processInfo?.process_info?.foreground_processes ?? []).find(isHermesProcess);
    if (hermesProc) {
      const termId = hermesTerminalId(hermesProc.pid);
      if (termId) sessionId = hermesBreadcrumbSession(hermesHome, termId, cwd);
    }
  }

  if (sessionId === null) throw new ConversationUnavailable("no_session_path");
  const dbPath = hermesDbPath(hermesHome);
  if (!existsSync(dbPath)) throw new ConversationUnavailable("transcript_missing");

  return { sessionId, dbPath };
}

const hermesCache = new Map<string, {
  signature: string;
  turns: ConversationTurn[];
}>();

/** Drops parsed pages for a closed pane's database, or every page during test cleanup. */
export function forgetHermesTranscriptState(path?: string): void {
  if (path === undefined) {
    hermesCache.clear();
    return;
  }
  for (const key of [...hermesCache.keys()]) {
    if (key.startsWith(`${path}\0`)) hermesCache.delete(key);
  }
}

const PAGE_SIZE = 100;

/** Reads a bounded tool result by call ID from the selected session only. */
export function hermesToolOutput(sessionId: string, dbPath: string, ref: string, maxChars: number): string | null {
  let db: Database;
  try { db = new Database(dbPath, { readonly: true, create: false }); }
  catch { return null; }
  try {
    const row = db.query<{ content: string | null }, [number, string, string]>(
      `SELECT substr(content, 1, ?) AS content FROM messages
       WHERE session_id = ? AND role = 'tool' AND tool_call_id = ? AND (active = 1 OR compacted = 1)
       ORDER BY id DESC LIMIT 1`,
    ).get(maxChars, sessionId, ref);
    return row?.content?.slice(0, maxChars) ?? null;
  } finally { db.close(); }
}

/** Widens a bounded row window to the user message that starts its exchange. */
function hermesPageStart(db: Database, sessionId: string, before: number, floor: number): number {
  const window = db.query<{ id: number }, [string, number, number]>(
    `SELECT id FROM messages
     WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id < ? AND id >= ?
     ORDER BY id DESC LIMIT ${PAGE_SIZE}`,
  ).all(sessionId, before, floor);
  const first = window.at(-1);
  if (!first) return before;
  const user = db.query<{ id: number | null }, [string, number, number]>(
    `SELECT MAX(id) AS id FROM messages
     WHERE session_id = ? AND (active = 1 OR compacted = 1) AND role = 'user' AND id <= ? AND id >= ?`,
  ).get(sessionId, first.id, floor);
  return user?.id ?? floor;
}

/** Reads recorded reasoning settings without treating cumulative token usage as context. */
function hermesMetadata(session: { model?: string | null; model_config?: string | null } | null): ConversationMetadata {
  let reasoningEffort: string | null = null;
  if (session?.model_config) {
    try {
      const parsed = JSON.parse(session.model_config) as {
        reasoning_config?: { enabled?: unknown; effort?: unknown } | string;
        reasoning_effort?: unknown;
      };
      const config = parsed.reasoning_config;
      if (typeof config === "object" && config !== null) {
        if (config.enabled === false) reasoningEffort = "off";
        else if (typeof config.effort === "string") reasoningEffort = config.effort;
      } else if (typeof config === "string") reasoningEffort = config;
      else if (typeof parsed.reasoning_effort === "string") reasoningEffort = parsed.reasoning_effort;
    } catch { /* invalid model configuration */ }
  }
  return { model: session?.model ?? null, reasoning_effort: reasoningEffort };
}

/**
 * Reads a consistent SQLite snapshot with whole exchanges at page boundaries.
 * Held pages include their starting row; a held start outside the newest window
 * advances to that window, with before/since pages covering the gap.
 * Page contents name the cache version so WAL edits invalidate unchanged row counts.
 */
export function hermesConversationPage(
  sessionId: string,
  dbPath: string,
  page: ConversationPage = {},
): RecognizedConversation {
  let stat: Stats;
  try {
    stat = statSync(dbPath);
  } catch {
    throw new ConversationUnavailable("transcript_missing");
  }

  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true, create: false });
  } catch {
    throw new ConversationUnavailable("transcript_missing");
  }

  try {
    return db.transaction((): RecognizedConversation => {
      const sessionRow = db.query<{
        id: string;
        model?: string | null;
        model_config?: string | null;
        started_at: number;
      }, [string]>(
        "SELECT id, model, model_config, started_at FROM sessions WHERE id = ?",
      ).get(sessionId);

      const firstRow = db.query<{ id: number }, [string]>(
        "SELECT id FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1) ORDER BY id ASC LIMIT 1",
      ).get(sessionId);

      if (!firstRow) {
        throw new ConversationNotStarted(sessionId, "hermes-transcript");
      }

      const identity = createHash("sha256").update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${sessionRow?.started_at ?? ""}`).digest("base64url").slice(0, 16);
      const historyId = `hermes:${sessionId}:${identity}`;
      const cacheKey = page.before !== undefined
        ? `${dbPath}\0${historyId}\0before:${page.before}:${page.since ?? ""}`
        : `${dbPath}\0${historyId}\0from:${page.from ?? ""}`;
      const prefix = `${historyId}:`;

      /** Accepts only an exchange boundary still present in this database generation. */
      const parseCursor = (cursor: string): number => {
        if (!cursor.startsWith(prefix)) throw new HistoryChanged();
        const value = cursor.slice(prefix.length);
        const id = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < firstRow.id) throw new HistoryChanged();
        const row = db.query<{ role: string }, [string, number]>(
          "SELECT role FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id = ?",
        ).get(sessionId, id);
        if (!row || (id !== firstRow.id && row.role !== "user")) throw new HistoryChanged();
        return id;
      };

      let start: number;
      let before: number;
      if (page.before !== undefined) {
        before = parseCursor(page.before);
        const floor = page.since === undefined ? firstRow.id : parseCursor(page.since);
        if (floor > before) throw new HistoryChanged();
        start = hermesPageStart(db, sessionId, before, floor);
      } else {
        if (page.since !== undefined) throw new HistoryChanged();
        before = Number.MAX_SAFE_INTEGER;
        const newest = hermesPageStart(db, sessionId, before, firstRow.id);
        const held = page.from === undefined ? null : parseCursor(page.from);
        start = held === null ? newest : Math.max(held, newest);
      }

      const rows = db.query<HermesMessageRow, [string, number, number]>(
        `SELECT id, role, content, tool_call_id, tool_calls, tool_name, reasoning, timestamp
         FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id >= ? AND id < ?
         ORDER BY id ASC`,
      ).all(sessionId, start, before);
      const cursor = start > firstRow.id ? `${prefix}${start}` : null;
      const metadata = hermesMetadata(sessionRow);
      const signature = createHash("sha256").update(JSON.stringify([rows, metadata, cursor])).digest("base64url");
      const version = answerVersion(cacheKey, signature);
      const cached = hermesCache.get(cacheKey);
      if (cached?.signature === signature) {
        return { source: "hermes-transcript", turns: cached.turns, metadata, cursor, history_id: historyId, version };
      }
      const turns = parseHermesRows(rows);
      hermesCache.set(cacheKey, { signature, turns });
      if (hermesCache.size > 64) hermesCache.delete(hermesCache.keys().next().value!);

      return {
        source: "hermes-transcript",
        turns,
        metadata,
        cursor,
        history_id: historyId,
        version,
      };
    })();
  } finally {
    db.close();
  }
}

/** Groups assistant activity and matched tool results into turns, preserving recorded reasoning. */
export function parseHermesRows(rows: readonly HermesMessageRow[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pendingTools = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();

  for (const row of rows) {
    const ts = row.timestamp ? new Date(row.timestamp * 1000).toISOString() : null;

    if (row.role === "user") {
      const text = typeof row.content === "string" ? row.content : "";
      turns.push({
        role: "user",
        ts,
        parts: [{ kind: "text", text }],
      });
    } else if (row.role === "assistant") {
      let turn = turns[turns.length - 1];
      if (!turn || turn.role !== "assistant") {
        turn = { role: "assistant", ts, parts: [] };
        turns.push(turn);
      }
      if (ts) turn.end_ts = ts;

      if (typeof row.reasoning === "string" && row.reasoning.trim().length > 0) {
        turn.parts.push({ kind: "thinking", text: row.reasoning.trim() });
      }

      if (row.tool_calls) {
        try {
          const parsed = JSON.parse(row.tool_calls);
          if (Array.isArray(parsed)) {
            for (const call of parsed) {
              const callId = String(call.id ?? call.tool_call_id ?? "");
              const fn = call.function ?? call;
              const name = String(fn.name ?? call.name ?? "tool");
              const rawArgs = fn.arguments ?? call.arguments ?? "{}";
              let inputStr = "";
              let inputObj: Record<string, unknown> = {};
              if (typeof rawArgs === "string") {
                inputStr = rawArgs;
                try { inputObj = JSON.parse(rawArgs); } catch {}
              } else if (typeof rawArgs === "object" && rawArgs !== null) {
                inputObj = rawArgs as Record<string, unknown>;
                inputStr = JSON.stringify(rawArgs);
              }
              const summary = toolSummary(name, inputObj);
              const toolPart: Extract<ConversationPart, { kind: "tool" }> = {
                kind: "tool",
                name,
                summary,
                input: inputStr,
                output: "",
              };
              turn.parts.push(toolPart);
              if (callId) pendingTools.set(callId, toolPart);
            }
          }
        } catch { /* malformed tool_calls json */ }
      }

      if (typeof row.content === "string" && row.content.trim().length > 0) {
        turn.parts.push({ kind: "text", text: row.content });
      }
    } else if (row.role === "tool") {
      const callId = row.tool_call_id ?? "";
      const toolPart = pendingTools.get(callId);
      const output = typeof row.content === "string" ? row.content : "";

      if (toolPart) {
        trimOutput(toolPart, output, callId);
        if (/^(?:error|failed|exception)\b/i.test(output.trim())) {
          toolPart.error = true;
        }
        pendingTools.delete(callId);
      } else {
        let turn = turns[turns.length - 1];
        if (!turn || turn.role !== "assistant") {
          turn = { role: "assistant", ts, parts: [] };
          turns.push(turn);
        }
        const orphan: Extract<ConversationPart, { kind: "tool" }> = {
          kind: "tool",
          name: row.tool_name ?? "tool",
          summary: row.tool_name ?? "tool",
          input: "",
          output: "",
        };
        trimOutput(orphan, output, callId);
        if (/^(?:error|failed|exception)\b/i.test(output.trim())) {
          orphan.error = true;
        }
        turn.parts.push(orphan);
      }
    }
  }

  return turns;
}
