import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { forgetTranscriptState } from "./conversation.ts";

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

  process.env["HERMES_HOME"] = root;

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

  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
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
