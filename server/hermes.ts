import { Database } from "bun:sqlite";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, opendirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { open, stat } from "node:fs/promises";
import { promisify } from "node:util";

import type { ConversationMetadata, ConversationPart, ConversationTurn, HerdrPane } from "../shared/protocol.ts";
import { agentGet, paneProcessInfo } from "./herdr/client.ts";
import { answerVersion, ConversationNotStarted, ConversationUnavailable, type ConversationPage, HistoryChanged, type RecognizedConversation, TRANSCRIPT_WINDOW_BYTES } from "./conversation.ts";
import { toolSummary } from "./transcript-records.ts";
import { TOOL_OUTPUT_CHARS, trimOutput } from "./tool-output.ts";
import { processStartedAt } from "./process-start.ts";
import { hermesNativeFeatures, readHermesFile, type HermesCommandContext } from "./hermes-commands.ts";

/** Recognize only the native single-skill scaffold, not quoted or incomplete examples. */
function hermesSkillParts(text: string): ConversationPart[] | null {
  const header = /^\[IMPORTANT: The user has invoked the "([^"\r\n<>]{1,200})" skill, indicating they want you to follow its instructions\. The full skill content is loaded below\.\]\n\n/.exec(text);
  if (!header || text.endsWith("\n… trimmed")) return null;
  const footers = [...text.matchAll(/\n\n\[Skill directory: ([^\r\n\]]+)\]\nResolve any relative paths in this skill \(e\.g\. `scripts\/foo\.js`, `templates\/config\.yaml`\) against that directory, then run them with the terminal tool using the absolute path\./g)];
  // More than one footer can be a quoted envelope inside the body or request.
  // Without persisted provenance, keep that ambiguous message verbatim.
  if (footers.length !== 1) return null;
  const footer = footers[0]!;
  let suffix = text.slice(footer.index! + footer[0].length);
  const config = /^\n\n\[Skill config \(from [^\r\n]+\):\n(?:  [^\r\n]*\n)+\]/.exec(suffix);
  if (config) suffix = suffix.slice(config[0].length);
  const setup = /^\n\n\[Skill setup note: [^\r\n]*\]/.exec(suffix);
  if (setup) suffix = suffix.slice(setup[0].length);
  const support = /^\n\n\[This skill has supporting files \(paths relative to the skill directory above\):\]\n(?:- [^\r\n]+\n)+\nLoad any of these with skill_view\(name="[^"\r\n]+", file_path="<path>"\), or run scripts directly by absolute path \(e\.g\. `node [^\r\n]+\/scripts\/foo\.js`\)\./.exec(suffix);
  if (support) suffix = suffix.slice(support[0].length);
  const marker = "\n\nThe user has provided the following instruction alongside the skill invocation: ";
  let request = "";
  if (suffix.startsWith(marker)) request = suffix.slice(marker.length);
  else if (suffix && !/^\n\n\[Runtime note: [\s\S]*\]$/.test(suffix)) return null;
  // Only a complete trailing native note is scaffolding; a quoted marker or
  // an incomplete note in the user's request must not clip the rest of it.
  request = request.replace(/\n\n\[Runtime note: [^\[\]]*\]$/, "");
  return [
    ...(request ? [{ kind: "text" as const, text: request }] : []),
    { kind: "skill", skill: { name: header[1]!, evidence: "instructions", status: "loaded",
      path: `${footer[1]!.replace(/[\\/]$/, "")}/SKILL.md` } },
  ];
}

export interface HermesMessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_calls_bytes?: number | null;
  tool_name: string | null;
  reasoning: string | null;
  timestamp: number;
  output_size?: number | null;
  content_bytes?: number | null;
  reasoning_chars?: number | null;
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
const processHomes = new Map<string, { home: string | null; startedAt: number; at: number }>();
const PROCESS_HOME_TTL_MS = 30_000;

function sameProcessLifetime(pid: number, startedAt: number): boolean {
  const current = processStartedAt(pid);
  return current !== null && Math.abs(current - startedAt) <= (process.platform === "darwin" ? 1000 : 0);
}

/** The HERMES_HOME in one macOS `ps -E -o command=` line. */
export function hermesHomeInPsLine(text: string): string | null {
  return [...text.matchAll(/(?:^|\s)HERMES_HOME=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/g)].at(-1)?.[1] || null;
}

/** The HERMES_HOME a process started with, cached because a process's environment does not change. */
export async function processHermesHome(pid: number, argv: readonly string[] = []): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const startedAt = processStartedAt(pid);
  if (startedAt === null) return null;
  const key = `${pid}\0${argv.join("\0")}`;
  const known = processHomes.get(key);
  if (known && Date.now() - known.at < PROCESS_HOME_TTL_MS
    && Math.abs(known.startedAt - startedAt) <= (process.platform === "darwin" ? 1000 : 0)) return known.home;
  try {
    const env = await hermesProcessEnvironment(pid);
    if (!env || !sameProcessLifetime(pid, startedAt)) return null;
    const explicit = env.HERMES_HOME || null;
    if (!explicit) {
      processHomes.delete(key);
      processHomes.set(key, { home: null, startedAt, at: Date.now() });
      if (processHomes.size > 256) processHomes.delete(processHomes.keys().next().value!);
      return null;
    }
    if (!isAbsolute(explicit)) return null;
    const isDir = (await stat(explicit).catch(() => null))?.isDirectory();
    if (!isDir || !sameProcessLifetime(pid, startedAt)) return null;
    processHomes.delete(key);
    processHomes.set(key, { home: explicit, startedAt, at: Date.now() });
    if (processHomes.size > 256) processHomes.delete(processHomes.keys().next().value!);
    return explicit;
  } catch { return null; }
}

/** Recognizes the Hermes executable, including Python launching its entrypoint. */
export function isHermesProcess(entry: { name?: string; argv0?: string | null; argv?: readonly string[] | null }): boolean {
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

interface HermesProcess { pid: number; name?: string; argv0?: string | null; argv?: string[] | null; cwd?: string | null }

function isTuiGateway(process: HermesProcess): boolean {
  const args = process.argv ?? [];
  const executable = (args[0] ?? "").replaceAll("\\", "/").split("/").at(-1)!;
  if (!/^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*|py)(?:\.exe)?$/i.test(executable)) return false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-m") return args[i + 1] === "tui_gateway.entry";
    if (arg === "-c" || arg === "--" || !arg.startsWith("-")) return false;
    if (arg === "-X" || arg === "-W") i++;
  }
  return false;
}

/** Read native environment only on the server; never serialize it in an HTTP response. */
const run = promisify(execFile);

async function hermesProcessEnvironment(pid: number): Promise<Record<string, string> | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const file = await open(`/proc/${pid}/environ`, constants.O_RDONLY | constants.O_NONBLOCK);
      let data: string;
      try {
        const buffer = Buffer.alloc(1_048_577);
        let count = 0;
        while (count < buffer.length) {
          const { bytesRead } = await file.read(buffer, count, buffer.length - count, null);
          if (bytesRead === 0) break;
          count += bytesRead;
        }
        if (count === buffer.length) return null;
        data = buffer.subarray(0, count).toString("utf8");
      } finally { await file.close(); }
      return Object.fromEntries(data.split("\0").filter(entry => entry.includes("=")).map(entry => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }));
    }
    if (process.platform === "darwin") {
      const options = { encoding: "utf8" as const, timeout: 1500, killSignal: "SIGKILL" as const, maxBuffer: 1_048_576, windowsHide: true };
      const [cmdResult, envResult] = await Promise.all([
        run("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], options),
        run("/bin/ps", ["-E", "-ww", "-p", String(pid), "-o", "command="], options),
      ]);
      const command = cmdResult.stdout.trimEnd();
      const text = envResult.stdout;
      if (!command || !text.startsWith(`${command} `)) return null;
      const environment = text.slice(command.length);
      return Object.fromEntries([...environment.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/g)].map(match => [match[1]!, match[2]!]));
    }
  } catch { /* Unreadable process identity is not a default profile. */ }
  return null;
}

/** Bind an Ink session to an owned gateway PID and its exact process lifetime. */
export function hermesRuntimeSession(home: string, processes: readonly HermesProcess[]): string | null {
  try {
    const file = join(home, "runtime", "active_sessions.json");
    const registry = JSON.parse(readHermesFile(file).toString("utf8")) as { entries?: unknown };
    if (!Array.isArray(registry.entries)) return null;
    const sessions = new Set<string>();
    for (const gateway of processes.filter(isTuiGateway)) {
      if (!Number.isSafeInteger(gateway.pid) || gateway.pid <= 0) continue;
      const startedAt = processStartedAt(gateway.pid);
      if (startedAt === null) continue;
      for (const entry of registry.entries) {
        if (entry === null || typeof entry !== "object") continue;
        if (entry.pid !== gateway.pid || entry.surface !== "tui" || typeof entry.process_start_time !== "number"
          || !Number.isFinite(entry.process_start_time) || Math.abs(entry.process_start_time * 1000 - startedAt) > (process.platform === "darwin" ? 1000 : 10)) continue;
        if (typeof entry.session_id === "string" && /^[\w:.-]{1,200}$/.test(entry.session_id)) sessions.add(entry.session_id);
      }
      if (!sameProcessLifetime(gateway.pid, startedAt)) return null;
    }
    return sessions.size === 1 ? sessions.values().next().value! : null;
  } catch { return null; }
}

/** Resolve selected-process home, source dialect and environment without executing native code. */
export async function paneHermesCommandContext(paneId: string, configuredHome?: string): Promise<HermesCommandContext | null> {
  const info = await paneProcessInfo(paneId).catch(() => null);
  const processes = info?.foreground_processes ?? [];
  const launchers = processes.filter(isHermesProcess);
  const gateways = processes.filter(isTuiGateway);
  if (launchers.length !== 1 || gateways.length > 1) return null;
  const launcher = launchers[0]!;
  const native = gateways[0] ?? launcher;
  if (!Number.isSafeInteger(native.pid) || native.pid <= 0) return null;
  const startedAt = processStartedAt(native.pid);
  const launcherStartedAt = native === launcher ? startedAt : processStartedAt(launcher.pid);
  const env = await hermesProcessEnvironment(native.pid);
  if (startedAt === null || launcherStartedAt === null || !env || !env.HOME || !isAbsolute(env.HOME)) return null;
  if (process.platform === "linux") {
    try {
      const nativeRoot = statSync(`/proc/${native.pid}/root`), bridgeRoot = statSync("/");
      if (nativeRoot.dev !== bridgeRoot.dev || nativeRoot.ino !== bridgeRoot.ino
        || readlinkSync(`/proc/${native.pid}/ns/mnt`) !== readlinkSync("/proc/self/ns/mnt")) return null;
    } catch { return null; }
  }
  let home = configuredHome ?? env.HERMES_HOME;
  const root = env.HERMES_HOME || join(env.HOME, ".hermes");
  if (!isAbsolute(root)) return null;
  // /proc exposes exec-time environment, so an in-process profile override may
  // require a lifetime-bound breadcrumb rather than today's active_profile file.
  if (!configuredHome && (!home || existsSync(join(root, "active_profile")) || launcher.argv?.some(arg => arg === "--profile" || arg === "-p" || arg.startsWith("--profile=")))) {
    const candidates = [root];
    try {
      const profiles = opendirSync(join(root, "profiles"));
      try {
        let count = 0;
        for (let entry = profiles.readSync(); entry !== null; entry = profiles.readSync()) {
          if (++count > 64) return null;
          if (entry.isDirectory()) candidates.push(join(root, "profiles", entry.name));
        }
      } finally { profiles.closeSync(); }
    } catch { /* No named profiles. */ }
    const terminal = hermesTerminalId(launcher.pid);
    const matches = candidates.filter(candidate => hermesRuntimeSession(candidate, processes)
      || (terminal && launcher.cwd && hermesBreadcrumbSession(candidate, terminal, launcher.cwd, launcherStartedAt)));
    home = matches.length === 1 ? matches[0] : undefined;
  }
  if (!home || !isAbsolute(home)) return null;
  try {
    home = realpathSync(home);
    if (!statSync(home).isDirectory()) return null;
  } catch { return null; }
  const sources: string[] = [];
  for (const process of processes) for (const arg of process.argv ?? []) {
    if (/[\\/]ui-tui[\\/]dist[\\/]entry\.js$/.test(arg)) sources.push(dirname(dirname(dirname(arg))));
  }
  if (env.PYTHONPATH) sources.push(...env.PYTHONPATH.split(process.platform === "win32" ? ";" : ":").filter(isAbsolute));
  for (const arg of launcher.argv ?? []) {
    if (/[\\/]hermes(?:\.exe)?$/.test(arg)) {
      try {
        const path = realpathSync(arg);
        sources.push(dirname(path), dirname(dirname(dirname(path))));
      } catch { /* Missing launcher path. */ }
    }
  }
  for (const source of new Set(sources)) {
    const features = hermesNativeFeatures(source);
    if (!features) continue;
    if (!sameProcessLifetime(native.pid, startedAt) || !sameProcessLifetime(launcher.pid, launcherStartedAt)) return null;
    const filesystem = process.platform === "linux" ? `/proc/${native.pid}/root` : "/";
    return { ...features, home, userHome: env.HOME, env, cwd: native.cwd ?? launcher.cwd ?? undefined,
      docker: existsSync(join(filesystem, ".dockerenv")) || existsSync(join(filesystem, "run", ".containerenv")),
      s6: existsSync(join(filesystem, "run", "s6")) || existsSync(join(filesystem, "package", "admin", "s6-overlay")) };
  }
  return null;
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
    const data = JSON.parse(readHermesFile(marker, 8192).toString("utf8")) as { session_id?: unknown; cwd?: unknown; ts?: unknown };
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
    const info = await agentGet(paneId).catch(() => null);
    if (typeof info?.agent_session?.value === "string" && info.agent_session.value.length > 0) {
      sessionId = info.agent_session.value;
    }
  }

  let hermesProcess: HermesProcess | undefined;
  let processes: HermesProcess[] = [];
  if (configuredHome === undefined || sessionId === null) {
    const processInfo = await paneProcessInfo(paneId).catch(() => null);
    processes = processInfo?.foreground_processes ?? [];
    hermesProcess = processes.find(isTuiGateway) ?? processes.find(isHermesProcess);
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
  if (sessionId === null) sessionId = hermesRuntimeSession(hermesHome, processes);

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
const BOUNDARY_TOOL_CALLS_BYTES = 64 * 1024;
const PAGE_TOOL_CALLS_BYTES = 4 * 1024 * 1024;
function reasoningChars(): number {
  return Math.floor((TRANSCRIPT_WINDOW_BYTES - Buffer.byteLength("\n… trimmed", "utf8")) / 4);
}

/** Computes the 16-character generation identity for a Hermes session in a database. */
export function hermesTranscriptIdentity(dbPath: string, startedAt: number | string = ""): string | null {
  try {
    const stat = statSync(dbPath);
    return createHash("sha256").update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${startedAt}`).digest("base64url").slice(0, 16);
  } catch {
    return null;
  }
}

/** Formats an opaque generation-scoped full-output reference. */
export function hermesOutputRef(identity: string, callId: string): string {
  return `${identity}:${callId}`;
}

/** Parses an opaque full-output reference into generation identity and provider call ID. */
export function parseHermesOutputRef(ref: string): { identity: string; callId: string } | null {
  const colon = ref.indexOf(":");
  if (colon <= 0 || colon === ref.length - 1) return null;
  const identity = ref.slice(0, colon);
  const callId = ref.slice(colon + 1);
  if (identity.length !== 16 || callId.length === 0 || callId.length > 120) return null;
  return { identity, callId };
}

const TERMINAL_TOOLS = new Set(["bash", "terminal", "sh", "exec", "execute_command", "shell"]);

export function isTerminalTool(name?: string | null): boolean {
  return typeof name === "string" && TERMINAL_TOOLS.has(name.toLowerCase());
}

export function decodeTerminalEnvelope(raw: string): { output: string; failed: boolean } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["output"] !== "string") return null;
    let failed = false;
    const exitCode = obj["exit_code"];
    if (typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0) {
      failed = true;
    }
    const err = obj["error"];
    if (typeof err === "string" && err.trim().length > 0) {
      failed = true;
    }
    return { output: obj["output"], failed };
  } catch {
    return null;
  }
}

/** Hermes code-execution calls summarize with the first nonblank code line, falling back to file and standard fields. */
export function hermesToolSummary(name: string, input: Record<string, unknown>): string {
  if (typeof input["code"] === "string") {
    const firstLine = input["code"].split("\n").map(l => l.trim()).find(l => l.length > 0);
    if (firstLine) return firstLine.slice(0, 120);
  }
  return toolSummary(name, input);
}

/** Reads a bounded tool result by call ID from the selected session and transcript generation only. */
export function hermesToolOutput(sessionId: string, dbPath: string, ref: string, maxChars: number): string | null {
  const parsed = parseHermesOutputRef(ref);
  if (!parsed) return null;
  let db: Database;
  try { db = new Database(dbPath, { readonly: true, create: false }); }
  catch { return null; }
  try {
    const sessionRow = db.query<{ started_at: number | null }, [string]>(
      "SELECT started_at FROM sessions WHERE id = ?",
    ).get(sessionId);
    const currentIdentity = hermesTranscriptIdentity(dbPath, sessionRow?.started_at ?? "");
    if (!currentIdentity || currentIdentity !== parsed.identity) return null;

    const row = db.query<{ content: string | null; tool_name: string | null }, [number, string, string]>(
      `SELECT substr(content, 1, ?) AS content, tool_name FROM messages
       WHERE session_id = ? AND role = 'tool' AND tool_call_id = ? AND (active = 1 OR compacted = 1)
       ORDER BY id DESC LIMIT 1`,
    ).get(maxChars, sessionId, parsed.callId);
    if (!row?.content) return row?.content ?? null;
    const decoded = isTerminalTool(row.tool_name) ? decodeTerminalEnvelope(row.content) : null;
    const text = decoded !== null ? decoded.output : row.content;
    return text.slice(0, maxChars);
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
  const boundary = db.query<Pick<HermesMessageRow, "id" | "role" | "tool_call_id" | "tool_calls"> & { text_bytes: number }, [number, number, string, number, number, number]>(
    `SELECT id, role, tool_call_id,
       CASE WHEN length(CAST(tool_calls AS BLOB)) <= ? THEN tool_calls ELSE NULL END AS tool_calls,
       COALESCE(
         CASE
           WHEN role = 'tool' THEN length(CAST(substr(content, 1, ?) AS BLOB))
           ELSE length(CAST(content AS BLOB))
         END,
         0
       ) + COALESCE(length(CAST(tool_calls AS BLOB)), 0) + COALESCE(length(CAST(reasoning AS BLOB)), 0) + COALESCE(length(CAST(role AS BLOB)), 0) + COALESCE(length(CAST(tool_name AS BLOB)), 0) + COALESCE(length(CAST(tool_call_id AS BLOB)), 0) AS text_bytes
     FROM messages
     WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id >= ? AND id < ?
     ORDER BY id DESC LIMIT ?`,
  ).all(BOUNDARY_TOOL_CALLS_BYTES, TOOL_OUTPUT_CHARS, sessionId, floor, before, PAGE_SIZE * 2);
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
  const rows = db.query<HermesMessageRow, [number, number, number, number, string, number, number, number]>(
    `SELECT id, role,
       CASE WHEN role = 'tool' THEN substr(content, 1, ?) ELSE substr(content, 1, ?) END AS content,
       tool_call_id, CASE WHEN length(CAST(tool_calls AS BLOB)) <= ? THEN tool_calls ELSE NULL END AS tool_calls,
       length(CAST(tool_calls AS BLOB)) AS tool_calls_bytes,
       tool_name, substr(reasoning, 1, ?) AS reasoning, length(reasoning) AS reasoning_chars, timestamp,
       CASE WHEN role = 'tool' THEN length(content) ELSE NULL END AS output_size,
       CASE WHEN role != 'tool' THEN length(CAST(content AS BLOB)) ELSE NULL END AS content_bytes
     FROM messages
     WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id >= ? AND id < ?
     ORDER BY id ASC LIMIT ?`,
  ).all(TOOL_OUTPUT_CHARS, TRANSCRIPT_WINDOW_BYTES + 1, PAGE_TOOL_CALLS_BYTES, reasoningChars(), sessionId, start, before, PAGE_SIZE);

  for (const row of rows) {
    if (row.role !== "tool" && typeof row.content === "string") {
      const bytes = row.content_bytes ?? Buffer.byteLength(row.content, "utf8");
      if (bytes > TRANSCRIPT_WINDOW_BYTES) {
        row.content = clipOversizedNonTool(row.content, TRANSCRIPT_WINDOW_BYTES);
      }
    }
    if (typeof row.reasoning === "string" && (row.reasoning_chars ?? 0) > reasoningChars()) row.reasoning += "\n… trimmed";
  }

  return rows;
}

/** Reads forward from an already validated held row within the newest page, bounded by rows and bytes. */
function hermesRowsFrom(db: Database, sessionId: string, start: number): HermesMessageRow[] {
  const boundary = db.query<Pick<HermesMessageRow, "id" | "role" | "tool_call_id" | "tool_calls"> & { text_bytes: number }, [number, string, number, number]>(
    `SELECT id, role, tool_call_id, NULL AS tool_calls,
       COALESCE(
         CASE
           WHEN role = 'tool' THEN length(CAST(substr(content, 1, ?) AS BLOB))
           ELSE length(CAST(content AS BLOB))
         END,
         0
       ) + COALESCE(length(CAST(tool_calls AS BLOB)), 0) + COALESCE(length(CAST(reasoning AS BLOB)), 0) + COALESCE(length(CAST(role AS BLOB)), 0) + COALESCE(length(CAST(tool_name AS BLOB)), 0) + COALESCE(length(CAST(tool_call_id AS BLOB)), 0) AS text_bytes
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

  const rows = db.query<HermesMessageRow, [number, number, number, number, string, number, number, number]>(
    `SELECT id, role,
       CASE WHEN role = 'tool' THEN substr(content, 1, ?) ELSE substr(content, 1, ?) END AS content,
       tool_call_id, CASE WHEN length(CAST(tool_calls AS BLOB)) <= ? THEN tool_calls ELSE NULL END AS tool_calls,
       length(CAST(tool_calls AS BLOB)) AS tool_calls_bytes,
       tool_name, substr(reasoning, 1, ?) AS reasoning, length(reasoning) AS reasoning_chars, timestamp,
       CASE WHEN role = 'tool' THEN length(content) ELSE NULL END AS output_size,
       CASE WHEN role != 'tool' THEN length(CAST(content AS BLOB)) ELSE NULL END AS content_bytes
     FROM messages
     WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id >= ? AND id <= ?
     ORDER BY id ASC LIMIT ?`,
  ).all(TOOL_OUTPUT_CHARS, TRANSCRIPT_WINDOW_BYTES + 1, PAGE_TOOL_CALLS_BYTES, reasoningChars(), sessionId, start, endId, count);

  for (const row of rows) {
    if (row.role !== "tool" && typeof row.content === "string") {
      const bytes = row.content_bytes ?? Buffer.byteLength(row.content, "utf8");
      if (bytes > TRANSCRIPT_WINDOW_BYTES) {
        row.content = clipOversizedNonTool(row.content, TRANSCRIPT_WINDOW_BYTES);
      }
    }
    if (typeof row.reasoning === "string" && (row.reasoning_chars ?? 0) > reasoningChars()) row.reasoning += "\n… trimmed";
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
  try {
    statSync(dbPath);
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

      const identity = hermesTranscriptIdentity(dbPath, sessionRow?.started_at ?? "");
      if (!identity) throw new ConversationUnavailable("transcript_missing");
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
      const turns = parseHermesRows(rows, identity);
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
export function parseHermesRows(rows: readonly HermesMessageRow[], identity?: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pendingTools = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();
  const makeRef = (callId: string) => identity ? hermesOutputRef(identity, callId) : callId;
  for (const row of rows) {
    try {
      const ts = parseTimestamp(row.timestamp);

      if (row.role === "user") {
        const text = typeof row.content === "string" ? row.content : "";
        turns.push({
          role: "user",
          ts,
          parts: hermesSkillParts(text) ?? [{ kind: "text", text }],
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
                const summary = hermesToolSummary(name, inputObj);
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
        } else if ((row.tool_calls_bytes ?? 0) > PAGE_TOOL_CALLS_BYTES) {
          turn.parts.push({ kind: "tool", name: "tool", summary: "", input: "", output: "", arguments_omitted: true });
        }

        if (typeof row.content === "string" && row.content.trim().length > 0) {
          turn.parts.push({ kind: "text", text: row.content });
        }
      } else if (row.role === "tool") {
        const callId = row.tool_call_id ?? "";
        const toolPart = pendingTools.get(callId);
        const rawOutput = typeof row.content === "string" ? row.content : "";
        const toolName = toolPart?.name ?? row.tool_name ?? "";
        const decoded = isTerminalTool(toolName) ? decodeTerminalEnvelope(rawOutput) : null;
        const output = decoded !== null ? decoded.output : rawOutput;
        const isFailed = decoded !== null ? decoded.failed : /^(?:error|failed|exception)\b/i.test(output.trim());

        if (toolPart) {
          trimOutput(toolPart, output, makeRef(callId), row.output_size ?? undefined);
          if (isFailed) toolPart.error = true;
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
          trimOutput(orphan, output, makeRef(callId), row.output_size ?? undefined);
          if (isFailed) orphan.error = true;
          turn.parts.push(orphan);
        }
      }
    } catch { /* ignore individual malformed row */ }
  }

  return turns;
}
