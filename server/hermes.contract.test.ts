import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

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
  if (originalHermesHome === undefined) delete process.env["HERMES_HOME"];
  else process.env["HERMES_HOME"] = originalHermesHome;
  if (workspaceId) await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
});

const read = async (): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
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
  expect(written.history_id).toBe(`hermes:${sessionId}`);
  expect(written.turns.length).toBe(2);
  expect(written.turns[0]!.role).toBe("user");
  expect(written.turns[1]!.role).toBe("assistant");
});
