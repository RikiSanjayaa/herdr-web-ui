import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultHermesHome,
  forgetHermesTranscriptState,
  hermesBreadcrumbSession,
  hermesConversationPage,
  hermesDbPath,
  isHermesProcess,
  parseHermesRows,
  type HermesMessageRow,
} from "./hermes.ts";
import { ConversationNotStarted, HistoryChanged } from "./conversation.ts";

describe("hermes paths", () => {
  it("computes default hermes home and db path", () => {
    expect(defaultHermesHome("/test/home")).toBe("/test/home/.hermes");
    expect(hermesDbPath("/test/home/.hermes")).toBe("/test/home/.hermes/state.db");
  });
});

describe("hermes process identification", () => {
  it("recognizes hermes command in process info", () => {
    expect(isHermesProcess({ name: "hermes" })).toBe(true);
    expect(isHermesProcess({ name: "hermes.exe" })).toBe(true);
    expect(isHermesProcess({ argv0: "/home/riki/.local/bin/hermes" })).toBe(true);
    expect(isHermesProcess({ argv: ["C:\\Tools\\Hermes.EXE"] })).toBe(true);
    expect(isHermesProcess({ name: "python", argv: ["python3", "/path/to/hermes", "chat"] })).toBe(true);
    expect(isHermesProcess({ name: "python", argv: ["python", "/home/riki/.hermes/hermes-agent/hermes"] })).toBe(true);
    expect(isHermesProcess({ name: "node", argv0: "node" })).toBe(false);
    expect(isHermesProcess({ name: "claude" })).toBe(false);
    expect(isHermesProcess({ name: "bash" })).toBe(false);
  });
});

describe("hermes terminal breadcrumb resolution", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hermes-crumb-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads breadcrumb when cwd matches", () => {
    const sessionsDir = join(tempDir, "terminal-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const crumbFile = join(sessionsDir, "tty-dev-pts-9");
    writeFileSync(crumbFile, JSON.stringify({ session_id: "20261008_120000_abc123", cwd: "/home/riki/project", ts: 1791449000 }));

    expect(hermesBreadcrumbSession(tempDir, "tty-dev-pts-9", "/home/riki/project")).toBe("20261008_120000_abc123");
    expect(hermesBreadcrumbSession(tempDir, "tty-dev-pts-9", "/other/dir")).toBeNull();
    expect(hermesBreadcrumbSession(tempDir, "tty-dev-pts-8", "/home/riki/project")).toBeNull();
  });
});

describe("hermes message rows parsing", () => {
  it("maps user, assistant, thinking, tool calls and tool outputs to conversation turns", () => {
    const rows: HermesMessageRow[] = [
      {
        id: 1,
        role: "user",
        content: "Please check git status",
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        reasoning: null,
        timestamp: 1700000000,
      },
      {
        id: 2,
        role: "assistant",
        content: "Checking status now.",
        tool_call_id: null,
        tool_calls: JSON.stringify([
          {
            id: "call_1",
            function: { name: "bash", arguments: JSON.stringify({ command: "git status" }) },
          },
        ]),
        tool_name: null,
        reasoning: "User wants repository status. I should run git status.",
        timestamp: 1700000001,
      },
      {
        id: 3,
        role: "tool",
        content: "On branch main\nnothing to commit",
        tool_call_id: "call_1",
        tool_calls: null,
        tool_name: "bash",
        reasoning: null,
        timestamp: 1700000002,
      },
      {
        id: 4,
        role: "assistant",
        content: "Working tree is clean.",
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        reasoning: null,
        timestamp: 1700000003,
      },
    ];

    const turns = parseHermesRows(rows);
    expect(turns.length).toBe(2);

    expect(turns[0]!.role).toBe("user");
    expect(turns[0]!.parts).toEqual([{ kind: "text", text: "Please check git status" }]);

    expect(turns[1]!.role).toBe("assistant");
    expect(turns[1]!.parts[0]).toEqual({ kind: "thinking", text: "User wants repository status. I should run git status." });
    expect(turns[1]!.parts[1]).toMatchObject({
      kind: "tool",
      name: "bash",
      summary: "git status",
      input: '{"command":"git status"}',
      output: "On branch main\nnothing to commit",
    });
    expect(turns[1]!.parts[2]).toEqual({ kind: "text", text: "Checking status now." });
    expect(turns[1]!.parts[3]).toEqual({ kind: "text", text: "Working tree is clean." });
  });

  it("handles tool errors properly", () => {
    const rows: HermesMessageRow[] = [
      {
        id: 1,
        role: "assistant",
        content: null,
        tool_call_id: null,
        tool_calls: JSON.stringify([
          { id: "call_bad", function: { name: "bash", arguments: '{"command":"false"}' } },
        ]),
        tool_name: null,
        reasoning: null,
        timestamp: 1700000000,
      },
      {
        id: 2,
        role: "tool",
        content: "Error: command failed with code 1",
        tool_call_id: "call_bad",
        tool_calls: null,
        tool_name: "bash",
        reasoning: null,
        timestamp: 1700000001,
      },
    ];

    const turns = parseHermesRows(rows);
    expect(turns.length).toBe(1);
    const toolPart = turns[0]!.parts[0];
    expect(toolPart?.kind).toBe("tool");
    if (toolPart?.kind === "tool") {
      expect(toolPart.error).toBe(true);
    }
  });
});

describe("hermesConversationPage SQLite integration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hermes-sqlite-test-"));
    dbPath = join(tempDir, "state.db");
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
    forgetHermesTranscriptState();
  });

  afterEach(() => {
    forgetHermesTranscriptState();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws ConversationNotStarted when session has no messages", () => {
    const db = new Database(dbPath);
    db.query("INSERT INTO sessions (id, model, started_at) VALUES (?, ?, ?)").run("empty_session", "test-model", 1700000000);
    db.close();

    expect(() => hermesConversationPage("empty_session", dbPath)).toThrow(ConversationNotStarted);
  });

  it("reads structured conversation turns and metadata", () => {
    const db = new Database(dbPath);
    db.query("INSERT INTO sessions (id, model, model_config, started_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s1", "claude-3-7-sonnet", JSON.stringify({ reasoning_effort: "high" }), 1700000000, 1500, 300);
    db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)")
      .run("s1", "user", "Hello Hermes", 1700000001);
    db.query("INSERT INTO messages (session_id, role, content, reasoning, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run("s1", "assistant", "Hello! How can I help you?", "Thinking about greeting.", 1700000002);
    db.close();

    const result = hermesConversationPage("s1", dbPath);
    expect(result.source).toBe("hermes-transcript");
    expect(result.history_id).toBe("hermes:s1");
    expect(result.metadata.model).toBe("claude-3-7-sonnet");
    expect(result.metadata.reasoning_effort).toBe("high");
    expect(result.metadata.context).toEqual({ used: 1800, window: null });
    expect(result.turns.length).toBe(2);
    expect(result.turns[0]!.role).toBe("user");
    expect(result.turns[1]!.role).toBe("assistant");
    expect(result.turns[1]!.parts[0]).toEqual({ kind: "thinking", text: "Thinking about greeting." });
    expect(result.turns[1]!.parts[1]).toEqual({ kind: "text", text: "Hello! How can I help you?" });
    expect(result.cursor).toBeNull();
  });

  it("supports pagination with before cursor", () => {
    const db = new Database(dbPath);
    db.query("INSERT INTO sessions (id, model, started_at) VALUES (?, ?, ?)").run("s_page", "m", 1700000000);

    for (let i = 1; i <= 150; i++) {
      db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)")
        .run("s_page", i % 2 === 1 ? "user" : "assistant", `Message ${i}`, 1700000000 + i);
    }
    db.close();

    const newestPage = hermesConversationPage("s_page", dbPath);
    expect(newestPage.turns.length).toBe(100);
    expect(newestPage.cursor).toBe("hermes:s_page:51");

    const olderPage = hermesConversationPage("s_page", dbPath, { before: newestPage.cursor! });
    expect(olderPage.turns.length).toBe(50);
    expect(olderPage.cursor).toBeNull();
  });

  it("throws HistoryChanged on invalid cursor", () => {
    const db = new Database(dbPath);
    db.query("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run("s_curs", 1700000000);
    db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)").run("s_curs", "user", "hi", 1700000001);
    db.close();

    expect(() => hermesConversationPage("s_curs", dbPath, { before: "other:session:10" })).toThrow(HistoryChanged);
  });
});
