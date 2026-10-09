import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readFile, stat } from "node:fs/promises";

import type { ConversationMetadata, ConversationPart, ConversationTurn, HerdrPane } from "../shared/protocol.ts";
import { herdrRpc } from "./herdr/client.ts";
import { answerVersion, ConversationNotStarted, ConversationUnavailable, type ConversationPage, HistoryChanged, type RecognizedConversation, TRANSCRIPT_WINDOW_BYTES } from "./conversation.ts";
import { toolSummary } from "./transcript-records.ts";
import { TOOL_OUTPUT_CHARS, trimOutput } from "./tool-output.ts";
import { processStartedAt } from "./process-start.ts";

export interface HermesMessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  reasoning: string | null;
  timestamp: number;
  output_size?: number | null;
  content_bytes?: number | null;
}

/** Clips non-tool row content that exceeds the byte budget and marks it trimmed. */
function clipOversizedNonTool(content: string, maxBytes: number): string {
  const suffix = "\n… trimmed";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const budget = Math.max(0, maxBytes - suffixBytes);
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= maxBytes) return content;
  return `${buf.subarray(0, budget).toString("utf8")}${suffix}`;
}

/** Safely formats a unix timestamp in seconds as an ISO string, or null if invalid. */
function parseTimestamp(ts: unknown): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  try {
    const d = new Date(ts * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/** Safely extracts raw input string for display and a record object for summary generation. */
function parseToolInput(rawArgs: unknown): { inputStr: string; inputObj: Record<string, unknown> } {
  if (rawArgs === null) return { inputStr: "null", inputObj: {} };
  if (rawArgs === undefined) return { inputStr: "", inputObj: {} };
  if (typeof rawArgs === "string") {
    let inputObj: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        inputObj = parsed as Record<string, unknown>;
      }
    } catch {}
    return { inputStr: rawArgs, inputObj };
  }
  if (typeof rawArgs === "object") {
    if (!Array.isArray(rawArgs)) {
      return { inputStr: JSON.stringify(rawArgs), inputObj: rawArgs as Record<string, unknown> };
    }
    return { inputStr: JSON.stringify(rawArgs), inputObj: {} };
  }
  return { inputStr: String(rawArgs), inputObj: {} };
}

/** Uses HERMES_HOME when set, otherwise the user's .hermes directory. */
export function defaultHermesHome(userHome?: string): string {
  return process.env["HERMES_HOME"] || join(userHome ?? process.env["HOME"] ?? "", ".hermes");
}

/** Locates the session database within the selected Hermes home. */
export function hermesDbPath(hermesHome = defaultHermesHome()): string {
  return join(hermesHome, "state.db");
}

/** What processHermesHome found, by pid and argv, and when. */
const processHomes = new Map<string, { home: string | null; at: number }>();
const PROCESS_HOME_TTL_MS = 30_000;

/** The HERMES_HOME in one macOS `ps -E -o command=` line. */
export function hermesHomeInPsLine(text: string): string | null {
  return [...text.matchAll(/(?:^|\s)HERMES_HOME=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/g)].at(-1)?.[1] || null;
}

/** The HERMES_HOME a process started with, cached because a process's environment does not change. */
export async function processHermesHome(pid: number, argv: readonly string[] = []): Promise<string | null> {
  const key = `${pid}\0${argv.join("\0")}`;
  const known = processHomes.get(key);
  if (known && Date.now() - known.at < PROCESS_HOME_TTL_MS) return known.home;
  let home: string | null = null;
  try {
    if (process.platform === "linux") {
      home = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").find((entry) => entry.startsWith("HERMES_HOME="))?.slice(12) || null;
    } else if (process.platform === "darwin") {
      const child = Bun.spawn(["/bin/ps", "-E", "-ww", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => child.kill(), 3000);
      try {
        const text = await new Response(child.stdout).text();
        await child.exited;
        home = hermesHomeInPsLine(text);
      } finally { clearTimeout(timer); }
    }
    if (home === null || !isAbsolute(home) || !(await stat(home)).isDirectory()) home = null;
  } catch { home = null; }
  processHomes.delete(key);
  processHomes.set(key, { home, at: Date.now() });
  if (processHomes.size > 256) processHomes.delete(processHomes.keys().next().value!);
  return home;
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

/** Reads a breadcrumb written during this Hermes process's lifetime for the same canonical cwd. */
export function hermesBreadcrumbSession(home: string, terminalId: string, cwd: string, startedAt: number): string | null {
  if (!Number.isFinite(startedAt)) return null;
  try {
    const marker = join(home, "terminal-sessions", terminalId);
    const markerStat = statSync(marker);
    if (!markerStat.isFile() || markerStat.size > 8192) return null;
    const data = JSON.parse(readFileSync(marker, "utf8")) as { session_id?: unknown; cwd?: unknown; ts?: unknown };
    if (typeof data.session_id !== "string" || data.session_id.trim().length === 0) return null;
    if (typeof data.cwd !== "string" || realpathSync(data.cwd) !== realpathSync(cwd)) return null;
    if (typeof data.ts !== "number" || !Number.isFinite(data.ts) || data.ts * 1000 < startedAt - 1000) return null;
    return data.session_id;
  } catch {
    return null;
  }
}

/**
 * Resolves the Hermes session and store for a pane. A reported session is authoritative;
 * one process lookup supplies the pane's store and, when needed, breadcrumb evidence.
 */
export async function hermesTranscriptForPane(
  pane: HerdrPane,
  cwd: string,
  configuredHome?: string,
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

  let hermesProcess: { pid: number; name?: string; argv0?: string; argv?: string[] } | undefined;
  if (configuredHome === undefined || sessionId === null) {
    const processInfo = await herdrRpc<{
      process_info?: { foreground_processes?: { pid: number; name?: string; argv0?: string; argv?: string[] }[] };
    }>("pane.process_info", { pane_id: paneId }).catch(() => null);
    hermesProcess = (processInfo?.process_info?.foreground_processes ?? []).find(isHermesProcess);
  }

  const processHome = configuredHome === undefined && hermesProcess !== undefined
    ? await processHermesHome(hermesProcess.pid, hermesProcess.argv ?? [])
    : null;
  const hermesHome = configuredHome ?? processHome ?? defaultHermesHome();

  if (sessionId === null && hermesProcess !== undefined) {
    const termId = hermesTerminalId(hermesProcess.pid);
    const startedAt = processStartedAt(hermesProcess.pid);
    if (termId !== null && startedAt !== null) {
      sessionId = hermesBreadcrumbSession(hermesHome, termId, cwd, startedAt);
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
    processHomes.clear();
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
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

/** End of an assistant call group and its contiguous results, or its starting index. */
function toolGroupEnd(rows: readonly Pick<HermesMessageRow, "role" | "tool_call_id" | "tool_calls">[], start: number): number {
  const call = rows[start];
  if (call?.role !== "assistant" || !call.tool_calls) return start;
  try {
    const parsed = JSON.parse(call.tool_calls) as unknown;
    if (!Array.isArray(parsed)) return start;
    const callIds = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const value = item as { id?: unknown; tool_call_id?: unknown };
      const id = String(value.id ?? value.tool_call_id ?? "");
      if (id) callIds.add(id);
    }
    let end = start + 1;
    while (end < rows.length && rows[end]!.role === "tool" && callIds.has(rows[end]!.tool_call_id ?? "")) end++;
    return end > start + 1 ? end : start;
  } catch {
    return start;
  }
}

/** Selects at most PAGE_SIZE active rows and TRANSCRIPT_WINDOW_BYTES before a row cursor, returning them chronologically. */
function hermesRowsBefore(db: Database, sessionId: string, before: number, floor: number): HermesMessageRow[] {
  const boundary = db.query<Pick<HermesMessageRow, "id" | "role" | "tool_call_id" | "tool_calls"> & { text_bytes: number }, [number, string, number, number, number]>(
    `SELECT id, role, tool_call_id, tool_calls,
       COALESCE(
         CASE
           WHEN role = 'tool' THEN octet_length(substr(content, 1, ?))
           ELSE octet_length(content)
         END,
         0
       ) + COALESCE(octet_length(tool_calls), 0) + COALESCE(octet_length(reasoning), 0) + COALESCE(octet_length(role), 0) + COALESCE(octet_length(tool_name), 0) + COALESCE(octet_length(tool_call_id), 0) AS text_bytes
     FROM messages
     WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id >= ? AND id < ?
     ORDER BY id DESC LIMIT ?`,
  ).all(TOOL_OUTPUT_CHARS, sessionId, floor, before, PAGE_SIZE * 2);
  boundary.reverse();

  let accumulatedBytes = 0;
  let rowCount = 0;
  let selected = boundary.length;
  for (let i = boundary.length - 1; i >= 0; i--) {
    const row = boundary[i]!;
    const rowBytes = row.text_bytes;
    if (rowCount === 0) {
      selected = i;
      rowCount = 1;
      accumulatedBytes = Math.min(rowBytes, TRANSCRIPT_WINDOW_BYTES);
      if (accumulatedBytes >= TRANSCRIPT_WINDOW_BYTES) break;
    } else {
      if (rowCount >= PAGE_SIZE || accumulatedBytes + rowBytes > TRANSCRIPT_WINDOW_BYTES) break;
      selected = i;
      rowCount++;
      accumulatedBytes += rowBytes;
    }
  }

  for (let candidate = Math.max(0, selected - PAGE_SIZE); candidate < selected; candidate++) {
    const end = toolGroupEnd(boundary, candidate);
    if (end > selected && end < boundary.length && end - candidate <= PAGE_SIZE) {
      let groupBytes = 0;
      for (let k = candidate; k < end; k++) groupBytes += boundary[k]!.text_bytes;
      if (groupBytes <= TRANSCRIPT_WINDOW_BYTES) {
        selected = end;
        break;
      }
    }
  }

  const start = boundary[selected]?.id ?? before;
  const rows = db.query<HermesMessageRow, [number, number, string, number, number, number]>(
    `SELECT id, role,
       CASE WHEN role = 'tool' THEN substr(content, 1, ?) ELSE substr(content, 1, ?) END AS content,
       tool_call_id, tool_calls, tool_name, reasoning, timestamp,
       CASE WHEN role = 'tool' THEN length(content) ELSE NULL END AS output_size,
       CASE WHEN role != 'tool' THEN octet_length(content) ELSE NULL END AS content_bytes
     FROM messages
     WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id >= ? AND id < ?
     ORDER BY id ASC LIMIT ?`,
  ).all(TOOL_OUTPUT_CHARS, TRANSCRIPT_WINDOW_BYTES + 1, sessionId, start, before, PAGE_SIZE);

  for (const row of rows) {
    if (row.role !== "tool" && typeof row.content === "string") {
      const bytes = row.content_bytes ?? Buffer.byteLength(row.content, "utf8");
      if (bytes > TRANSCRIPT_WINDOW_BYTES) {
        row.content = clipOversizedNonTool(row.content, TRANSCRIPT_WINDOW_BYTES);
      }
    }
  }

  return rows;
}

/** Reads forward from an already validated held row within the newest page, bounded by rows and bytes. */
function hermesRowsFrom(db: Database, sessionId: string, start: number): HermesMessageRow[] {
  const boundary = db.query<Pick<HermesMessageRow, "id" | "role" | "tool_call_id" | "tool_calls"> & { text_bytes: number }, [number, string, number, number]>(
    `SELECT id, role, tool_call_id, tool_calls,
       COALESCE(
         CASE
           WHEN role = 'tool' THEN octet_length(substr(content, 1, ?))
           ELSE octet_length(content)
         END,
         0
       ) + COALESCE(octet_length(tool_calls), 0) + COALESCE(octet_length(reasoning), 0) + COALESCE(octet_length(role), 0) + COALESCE(octet_length(tool_name), 0) + COALESCE(octet_length(tool_call_id), 0) AS text_bytes
     FROM messages
     WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id >= ?
     ORDER BY id ASC LIMIT ?`,
  ).all(TOOL_OUTPUT_CHARS, sessionId, start, PAGE_SIZE);

  let accumulatedBytes = 0;
  let endId: number | null = null;
  let count = 0;
  for (const row of boundary) {
    if (count === 0) {
      count = 1;
      accumulatedBytes = Math.min(row.text_bytes, TRANSCRIPT_WINDOW_BYTES);
      endId = row.id;
      if (accumulatedBytes >= TRANSCRIPT_WINDOW_BYTES) break;
    } else {
      if (accumulatedBytes + row.text_bytes > TRANSCRIPT_WINDOW_BYTES) break;
      count++;
      accumulatedBytes += row.text_bytes;
      endId = row.id;
    }
  }

  if (endId === null) return [];

  const rows = db.query<HermesMessageRow, [number, number, string, number, number, number]>(
    `SELECT id, role,
       CASE WHEN role = 'tool' THEN substr(content, 1, ?) ELSE substr(content, 1, ?) END AS content,
       tool_call_id, tool_calls, tool_name, reasoning, timestamp,
       CASE WHEN role = 'tool' THEN length(content) ELSE NULL END AS output_size,
       CASE WHEN role != 'tool' THEN octet_length(content) ELSE NULL END AS content_bytes
     FROM messages
     WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id >= ? AND id <= ?
     ORDER BY id ASC LIMIT ?`,
  ).all(TOOL_OUTPUT_CHARS, TRANSCRIPT_WINDOW_BYTES + 1, sessionId, start, endId, count);

  for (const row of rows) {
    if (row.role !== "tool" && typeof row.content === "string") {
      const bytes = row.content_bytes ?? Buffer.byteLength(row.content, "utf8");
      if (bytes > TRANSCRIPT_WINDOW_BYTES) {
        row.content = clipOversizedNonTool(row.content, TRANSCRIPT_WINDOW_BYTES);
      }
    }
  }

  return rows;
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
 * Reads a consistent SQLite snapshot in pages of at most PAGE_SIZE active rows.
 * Held pages include their starting row while it remains in the newest page; once
 * it falls behind, before/since pages cover the gap. Page contents name the cache
 * version so WAL edits invalidate unchanged row counts.
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

      /** Accepts any active row still present in this database generation. */
      const parseCursor = (cursor: string): number => {
        if (!cursor.startsWith(prefix)) throw new HistoryChanged();
        const value = cursor.slice(prefix.length);
        const id = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < firstRow.id) throw new HistoryChanged();
        const row = db.query<{ id: number }, [string, number]>(
          "SELECT id FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id = ?",
        ).get(sessionId, id);
        if (!row) throw new HistoryChanged();
        return id;
      };

      let rows: HermesMessageRow[];
      let start: number;
      if (page.before !== undefined) {
        const before = parseCursor(page.before);
        const floor = page.since === undefined ? firstRow.id : parseCursor(page.since);
        if (floor > before) throw new HistoryChanged();
        rows = hermesRowsBefore(db, sessionId, before, floor);
        start = rows[0]?.id ?? floor;
      } else {
        if (page.since !== undefined) throw new HistoryChanged();
        const newest = hermesRowsBefore(db, sessionId, Number.MAX_SAFE_INTEGER, firstRow.id);
        const held = page.from === undefined ? null : parseCursor(page.from);
        if (held !== null && held >= newest[0]!.id) {
          rows = hermesRowsFrom(db, sessionId, held);
          start = held;
        } else {
          rows = newest;
          start = newest[0]!.id;
        }
      }
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
  } catch (error) {
    if (error instanceof HistoryChanged || error instanceof ConversationNotStarted || error instanceof ConversationUnavailable) {
      throw error;
    }
    throw new ConversationUnavailable("transcript_missing");
  } finally {
    try { db.close(); } catch {}
  }
}

/** Groups assistant activity and matched tool results into turns, preserving recorded reasoning. */
export function parseHermesRows(rows: readonly HermesMessageRow[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pendingTools = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();

  for (const row of rows) {
    try {
      const ts = parseTimestamp(row.timestamp);

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
            const parsed = JSON.parse(row.tool_calls) as unknown;
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (typeof item !== "object" || item === null) continue;
                const call = item as Record<string, unknown>;
                const callId = String(call.id ?? call.tool_call_id ?? "");
                const fn = (typeof call.function === "object" && call.function !== null ? call.function : call) as Record<string, unknown>;
                const name = String(fn.name ?? call.name ?? "tool");
                const rawArgs = "arguments" in fn ? fn.arguments : "arguments" in call ? call.arguments : "{}";
                const { inputStr, inputObj } = parseToolInput(rawArgs);
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
          trimOutput(toolPart, output, callId, row.output_size ?? undefined);
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
          trimOutput(orphan, output, callId, row.output_size ?? undefined);
          if (/^(?:error|failed|exception)\b/i.test(output.trim())) {
            orphan.error = true;
          }
          turn.parts.push(orphan);
        }
      }
    } catch { /* ignore individual malformed row */ }
  }

  return turns;
}
