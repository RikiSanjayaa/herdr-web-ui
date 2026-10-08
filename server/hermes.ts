import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
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

export function defaultHermesHome(userHome?: string): string {
  return process.env["HERMES_HOME"] || join(userHome ?? process.env["HOME"] ?? "", ".hermes");
}

export function hermesDbPath(hermesHome = defaultHermesHome()): string {
  return join(hermesHome, "state.db");
}

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
  metadata: ConversationMetadata;
  cursor: string | null;
  version: string;
}>();

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

export function hermesConversationPage(
  sessionId: string,
  dbPath: string,
  page: ConversationPage = {},
): RecognizedConversation {
  let stat: { size: number; mtimeMs: number };
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
    const sessionRow = db.query<{
      id: string;
      model?: string | null;
      model_config?: string | null;
      started_at: number;
      input_tokens?: number | null;
      output_tokens?: number | null;
      reasoning_tokens?: number | null;
    }, [string]>(
      "SELECT id, model, model_config, started_at, input_tokens, output_tokens, reasoning_tokens FROM sessions WHERE id = ?",
    ).get(sessionId);

    const statsRow = db.query<{ max_id: number | null; count: number }, [string]>(
      "SELECT MAX(id) AS max_id, COUNT(*) AS count FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1)",
    ).get(sessionId);

    if (!statsRow || statsRow.count === 0) {
      throw new ConversationNotStarted(sessionId, "hermes-transcript");
    }

    const historyId = `hermes:${sessionId}`;
    const cacheKey = page.before !== undefined
      ? `${dbPath}\0${sessionId}\0before:${page.before}:${page.since ?? ""}`
      : `${dbPath}\0${sessionId}\0from:${page.from ?? ""}`;
    const signature = `${sessionId}:${statsRow.max_id ?? 0}:${statsRow.count}:${stat.size}:${stat.mtimeMs}`;
    const version = answerVersion(cacheKey, signature);

    const cached = hermesCache.get(cacheKey);
    if (cached && cached.signature === signature) {
      return {
        source: "hermes-transcript",
        turns: cached.turns,
        metadata: cached.metadata,
        cursor: cached.cursor,
        history_id: historyId,
        version,
      };
    }

    let rows: HermesMessageRow[];
    const prefix = `${historyId}:`;

    if (page.before !== undefined) {
      if (!page.before.startsWith(prefix)) throw new HistoryChanged();
      const beforeId = Number(page.before.slice(prefix.length));
      if (!Number.isSafeInteger(beforeId)) throw new HistoryChanged();
      const floorId = page.since !== undefined && page.since.startsWith(prefix) ? Number(page.since.slice(prefix.length)) : 0;
      rows = db.query<HermesMessageRow, [string, number, number]>(
        `SELECT id, role, content, tool_call_id, tool_calls, tool_name, reasoning, timestamp
         FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id < ? AND id >= ?
         ORDER BY id DESC LIMIT ${PAGE_SIZE}`,
      ).all(sessionId, beforeId, floorId).reverse();
    } else if (page.from !== undefined) {
      if (!page.from.startsWith(prefix)) throw new HistoryChanged();
      const fromId = Number(page.from.slice(prefix.length));
      if (!Number.isSafeInteger(fromId)) throw new HistoryChanged();
      rows = db.query<HermesMessageRow, [string, number]>(
        `SELECT id, role, content, tool_call_id, tool_calls, tool_name, reasoning, timestamp
         FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id > ?
         ORDER BY id ASC LIMIT ${PAGE_SIZE}`,
      ).all(sessionId, fromId);
    } else {
      rows = db.query<HermesMessageRow, [string]>(
        `SELECT id, role, content, tool_call_id, tool_calls, tool_name, reasoning, timestamp
         FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1)
         ORDER BY id DESC LIMIT ${PAGE_SIZE}`,
      ).all(sessionId).reverse();
    }

    let cursor: string | null = null;
    if (rows.length > 0) {
      const earliestId = rows[0]!.id;
      const older = db.query<{ id: number }, [string, number]>(
        "SELECT id FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id < ? LIMIT 1",
      ).get(sessionId, earliestId);
      if (older !== null) {
        cursor = `${historyId}:${earliestId}`;
      }
    }

    const turns = parseHermesRows(rows);

    let reasoningEffort: string | null = null;
    if (sessionRow?.model_config) {
      try {
        const parsed = JSON.parse(sessionRow.model_config) as { reasoning_config?: unknown; reasoning_effort?: unknown };
        if (typeof parsed.reasoning_config === "string") reasoningEffort = parsed.reasoning_config;
        else if (typeof parsed.reasoning_effort === "string") reasoningEffort = parsed.reasoning_effort;
      } catch { /* invalid json */ }
    }

    const metadata: ConversationMetadata = {
      model: sessionRow?.model ?? null,
      reasoning_effort: reasoningEffort,
      context: sessionRow?.input_tokens != null
        ? { used: (sessionRow.input_tokens ?? 0) + (sessionRow.output_tokens ?? 0), window: null }
        : undefined,
    };

    hermesCache.set(cacheKey, { signature, turns, metadata, cursor, version });
    if (hermesCache.size > 64) hermesCache.delete(hermesCache.keys().next().value!);

    return {
      source: "hermes-transcript",
      turns,
      metadata,
      cursor,
      history_id: historyId,
      version,
    };
  } finally {
    db.close();
  }
}

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
