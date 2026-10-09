import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { hermesTerminalId, isHermesProcess, processHermesHome } from "./hermes.ts";

interface RunningServer {
  port: number;
  hostname: string;
  stop: () => void;
}

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-hermes-contract-"));
const dbPath = join(root, "state.db");
const originalHermesHome = process.env["HERMES_HOME"];
let workspaceId: string | undefined;
let paneId: string;
let server: RunningServer;
let seq = Date.now() * 1000;
const sessionId = "hermes-contract-session-1";

beforeAll(async () => {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      model TEXT,
      model_config TEXT,
      started_at REAL NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      reasoning TEXT,
      timestamp REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      compacted INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.close();

  process.env["HERMES_HOME"] = join(root, "bridge-default-without-the-session");

  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-hermes-contract" });
  workspaceId = created.workspace.workspace_id;
  paneId = created.root_pane.pane_id;

  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "herdr:hermes", agent: "hermes", state: "idle", seq: ++seq });
  await herdrRpc("pane.report_agent_session", {
    pane_id: paneId,
    source: "herdr:hermes",
    agent: "hermes",
    seq: ++seq,
    agent_session_id: sessionId,
    session_start_source: "startup",
  });

  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), hermesHome: root });
});

afterAll(async () => {
  server?.stop();
  forgetTranscriptState();
  if (originalHermesHome === undefined) delete process.env["HERMES_HOME"];
  else process.env["HERMES_HOME"] = originalHermesHome;
  if (workspaceId) await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
});

/** Reads the owned pane through the authenticated conversation route. */
const read = async (page: { before?: string; since?: string; from?: string } = {}): Promise<ConversationResponse> => {
  const query = new URLSearchParams({ pane_id: paneId, ...page });
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?${query}`);
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};

/** Writes the real Hermes columns read by the bridge, with one complete exchange per session. */
function hermesStore(home: string, sessions: ReadonlyArray<{ id: string; answer: string }>): void {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, "state.db"));
  try {
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, model_config TEXT, started_at REAL NOT NULL);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, reasoning TEXT,
        timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0
      );
    `);
    const session = db.query("INSERT INTO sessions (id, model, started_at) VALUES (?, 'fixture-model', 1700000000)");
    const message = db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)");
    db.transaction(() => {
      for (const item of sessions) {
        session.run(item.id);
        message.run(item.id, "user", `Question for ${item.id}`, 1700000001);
        message.run(item.id, "assistant", item.answer, 1700000002);
      }
    })();
  } finally { db.close(); }
}

it("answers empty conversation before messages are written, then follows the sqlite database turns", async () => {
  expect(await read()).toMatchObject({
    source: "hermes-transcript",
    turns: [],
    cursor: null,
    history_id: `unwritten:${sessionId}`,
  });

  const db = new Database(dbPath);
  db.query("INSERT INTO sessions (id, model, started_at) VALUES (?, ?, ?)").run(sessionId, "nous-hermes-3", 1700000000);
  db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)").run(sessionId, "user", "Explain quantum computing", 1700000001);
  db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)").run(sessionId, "assistant", "Quantum computing uses qubits.", 1700000002);
  db.close();

  const written = await read();
  expect(written.source).toBe("hermes-transcript");
  expect(written.history_id).toStartWith(`hermes:${sessionId}:`);
  expect(written.turns.length).toBe(2);
  expect(written.turns[0]!.role).toBe("user");
  expect(written.turns[1]!.role).toBe("assistant");
});

it("advances a held read to a bounded newest page and fills every intervening row", async () => {
  const db = new Database(dbPath);
  try {
    db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    const insert = db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)");
    db.transaction(() => {
      for (let index = 1; index <= 150; index++) insert.run(sessionId, index % 2 ? "user" : "assistant", `Message ${index}`, 1700000000 + index);
    })();
  } finally { db.close(); }
  const held = await read();
  expect(held.turns).toHaveLength(100);

  const writer = new Database(dbPath);
  try {
    const insert = writer.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)");
    writer.transaction(() => {
      for (let index = 151; index <= 350; index++) insert.run(sessionId, index % 2 ? "user" : "assistant", `Message ${index}`, 1700000000 + index);
    })();
  } finally { writer.close(); }

  const newest = await read({ from: held.cursor! });
  expect(newest.turns).toHaveLength(100);
  expect(newest.turns[0]!.parts).toEqual([{ kind: "text", text: "Message 251" }]);
  expect(newest.turns.at(-1)!.parts).toEqual([{ kind: "text", text: "Message 350" }]);
  const middle = await read({ before: newest.cursor!, since: held.cursor! });
  const oldest = await read({ before: middle.cursor!, since: held.cursor! });
  expect(oldest.cursor).toBe(held.cursor);
  expect([...oldest.turns, ...middle.turns, ...newest.turns].flatMap(turn => turn.parts).map(part => part.kind === "text" ? part.text : ""))
    .toEqual(Array.from({ length: 300 }, (_, index) => `Message ${index + 51}`));

  const query = new URLSearchParams({ pane_id: paneId, before: newest.cursor!, since: "hermes:another-session:1" });
  const invalid = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?${query}`);
  expect(invalid.status).toBe(409);
  expect(await invalid.json()).toMatchObject({ error: { code: "history_changed" } });
});

it("changes the ETag when metadata changes in WAL without appending a message", async () => {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
    const url = `http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`;
    const before = await fetch(url);
    expect(before.status).toBe(200);
    const etag = before.headers.get("etag");
    expect(etag).not.toBeNull();
    db.query("UPDATE sessions SET model = ?, model_config = ? WHERE id = ?")
      .run("new-model", JSON.stringify({ reasoning_config: { enabled: true, effort: "high" } }), sessionId);
    const after = await fetch(url, { headers: { "if-none-match": etag! } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect((await after.json() as ConversationResponse).metadata).toEqual({ model: "new-model", reasoning_effort: "high" });
  } finally { db.close(); }
});

it("loads the whole output of a tool result cut in the conversation page", async () => {
  const output = "A fictional tool result.\n".repeat(300);
  const db = new Database(dbPath);
  try {
    db.query("INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES (?, 'assistant', ?, 1700000500)").run(sessionId,
      JSON.stringify([{ id: "large-tool", function: { name: "execute_code", arguments: '{"code":"print(result)"}' } }]),
    );
    db.query("INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp) VALUES (?, 'tool', ?, 'large-tool', 'execute_code', 1700000501)")
      .run(sessionId, output);
  } finally { db.close(); }
  const conversation = await read();
  const tool = conversation.turns.flatMap(turn => turn.parts).find(part => part.kind === "tool" && part.output_ref === "large-tool");
  expect(tool).toMatchObject({ output_ref: "large-tool", output_size: output.length });
  const query = new URLSearchParams({ pane_id: paneId, ref: "large-tool" });
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/tool-output?${query}`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(output);
});

it("falls back to scrollback when the Hermes database is corrupt or incompatible", async () => {
  const corruptHome = join(root, "corrupt-home");
  mkdirSync(corruptHome, { recursive: true });
  writeFileSync(join(corruptHome, "state.db"), "not a sqlite database");
  const corruptServer = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state-corrupt"), hermesHome: corruptHome });
  try {
    const query = new URLSearchParams({ pane_id: paneId });
    const response = await fetch(`http://127.0.0.1:${corruptServer.port}/api/pane/conversation?${query}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { source: string; turns: unknown[] };
    expect(body.source).toBe("scrollback");
    expect(body.turns).toEqual([]);

    const toolQuery = new URLSearchParams({ pane_id: paneId, ref: "any-tool" });
    const toolResp = await fetch(`http://127.0.0.1:${corruptServer.port}/api/pane/conversation/tool-output?${toolQuery}`);
    expect(toolResp.status).toBe(404);
  } finally {
    corruptServer.stop();
  }
});

it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("selects the pane process's store, prefers reports, validates breadcrumbs and falls back from an invalid process home", async () => {
  const profile = join(root, "process-profile");
  const fallback = process.env["HERMES_HOME"]!;
  const profileSession = "profile-session";
  const reportedSession = "reported-session";
  const fallbackSession = "fallback-session";
  hermesStore(profile, [
    { id: profileSession, answer: "Answer from the process profile" },
    { id: reportedSession, answer: "Answer from the reported session" },
  ]);
  hermesStore(fallback, [{ id: fallbackSession, answer: "Answer from the bridge default" }]);
  const executable = join(root, "hermes");
  copyFileSync("/bin/sleep", executable);
  chmodSync(executable, 0o755);
  const workspaces: string[] = [];
  const servers: RunningServer[] = [];

  const start = async (home: string): Promise<{ paneId: string; pid: number; argv: string[] }> => {
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-hermes-profile" });
    workspaces.push(created.workspace.workspace_id);
    const target = created.root_pane.pane_id;
    const quotedHome = home.replaceAll("'", "'\\''");
    const quotedExecutable = executable.replaceAll("'", "'\\''");
    await herdrRpc("pane.send_text", { pane_id: target, text: `HERMES_HOME='${quotedHome}' '${quotedExecutable}' 60\n` });
    // A real herdr process table has no completion signal; poll its observable process list to a deadline.
    for (let attempt = 0; attempt < 100; attempt++) {
      const info = await herdrRpc<{
        process_info?: { foreground_processes?: { pid: number; name?: string; argv0?: string; argv?: string[] }[] };
      }>("pane.process_info", { pane_id: target });
      const process = info.process_info?.foreground_processes?.find(isHermesProcess);
      if (process) return { paneId: target, pid: process.pid, argv: process.argv ?? [] };
      await Bun.sleep(25);
    }
    throw new Error("Hermes stand-in did not become the pane's foreground process");
  };

  const readPane = async (running: RunningServer, target: string): Promise<ConversationResponse> => {
    const response = await fetch(`http://127.0.0.1:${running.port}/api/pane/conversation?pane_id=${encodeURIComponent(target)}`);
    expect(response.status).toBe(200);
    return await response.json() as ConversationResponse;
  };

  try {
    const owned = await start(profile);
    await herdrRpc("pane.report_agent", { pane_id: owned.paneId, source: "herdr:hermes", agent: "hermes", state: "idle", seq: ++seq });
    await herdrRpc("pane.report_agent_session", {
      pane_id: owned.paneId, source: "herdr:hermes", agent: "hermes", seq: ++seq,
      agent_session_id: reportedSession, session_start_source: "startup",
    });
    expect((await sessionSnapshot()).panes.find((pane) => pane.pane_id === owned.paneId)?.agent_session?.agent).toBe("hermes");
    const terminalId = hermesTerminalId(owned.pid);
    expect(terminalId).not.toBeNull();
    const markerDir = join(profile, "terminal-sessions");
    mkdirSync(markerDir, { recursive: true });
    const marker = join(markerDir, terminalId!);
    writeFileSync(marker, JSON.stringify({ session_id: profileSession, cwd: root, ts: Date.now() / 1000 }));
    const local = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "profile-state") });
    servers.push(local);

    expect(await processHermesHome(owned.pid, owned.argv)).toBe(profile);
    const fromProfile = await readPane(local, owned.paneId);
    expect(fromProfile.source).toBe("hermes-transcript");
    expect(JSON.stringify(fromProfile.turns)).toContain("Answer from the reported session");

    const defaulted = await start(join(root, "missing-process-home"));
    await herdrRpc("pane.report_agent", { pane_id: defaulted.paneId, source: "herdr:hermes", agent: "hermes", state: "idle", seq: ++seq });
    await herdrRpc("pane.report_agent_session", {
      pane_id: defaulted.paneId, source: "herdr:hermes", agent: "hermes", seq: ++seq,
      agent_session_id: fallbackSession, session_start_source: "startup",
    });
    expect(JSON.stringify((await readPane(local, defaulted.paneId)).turns)).toContain("Answer from the bridge default");

    const breadcrumb = await start(profile);
    await herdrRpc("pane.report_agent", { pane_id: breadcrumb.paneId, source: "manual", agent: "hermes", state: "idle" });
    // Agent detection is an asynchronous herdr status update; poll the public snapshot to a deadline.
    let identified = false;
    for (let attempt = 0; attempt < 100 && !identified; attempt++) {
      identified = (await sessionSnapshot()).panes.find((pane) => pane.pane_id === breadcrumb.paneId)?.agent === "hermes";
      if (!identified) await Bun.sleep(25);
    }
    expect(identified).toBeTrue();
    const breadcrumbTerminal = hermesTerminalId(breadcrumb.pid);
    expect(breadcrumbTerminal).not.toBeNull();
    const breadcrumbMarker = join(profile, "terminal-sessions", breadcrumbTerminal!);
    writeFileSync(breadcrumbMarker, JSON.stringify({ session_id: profileSession, cwd: root, ts: 0 }));
    expect((await readPane(local, breadcrumb.paneId)).source).toBe("scrollback");
    writeFileSync(breadcrumbMarker, JSON.stringify({ session_id: profileSession, cwd: profile, ts: Date.now() / 1000 }));
    expect((await readPane(local, breadcrumb.paneId)).source).toBe("scrollback");
    writeFileSync(breadcrumbMarker, JSON.stringify({ session_id: profileSession, cwd: root, ts: Date.now() / 1000 }));
    const fromBreadcrumb = await readPane(local, breadcrumb.paneId);
    expect(fromBreadcrumb.source).toBe("hermes-transcript");
    expect(JSON.stringify(fromBreadcrumb.turns)).toContain("Answer from the process profile");
  } finally {
    for (const running of servers) running.stop();
    forgetTranscriptState();
    for (const workspace of workspaces) await workspaceClose(workspace);
  }
});
