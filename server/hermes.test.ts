import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultHermesHome,
  forgetHermesTranscriptState,
  hermesBreadcrumbSession,
  hermesConversationPage,
  hermesDbPath,
  hermesToolOutput,
  isHermesProcess,
  parseHermesRows,
  type HermesMessageRow,
} from "./hermes.ts";
import { ConversationNotStarted, HistoryChanged } from "./conversation.ts";
import { toolSummary } from "./transcript-records.ts";

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
  it("uses a file summary when a tool's code is blank", () => {
    expect(toolSummary("write_file", { code: " \n ", file_path: "example.ts" })).toBe("example.ts");
    expect(toolSummary("execute_code", { code: "\nprint('hello')\nprint('world')" })).toBe("print('hello')");
  });

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
    expect(result.history_id).toStartWith("hermes:s1:");
    expect(result.metadata.model).toBe("claude-3-7-sonnet");
    expect(result.metadata.reasoning_effort).toBe("high");
    expect(result.metadata.context).toBeUndefined();
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
    expect(newestPage.cursor).toBe(`${newestPage.history_id}:51`);

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

  /** Creates alternating turns so a 100-row page starts on a user message. */
  const populate = (count = 150): void => {
    const db = new Database(dbPath);
    try {
      db.query("INSERT INTO sessions (id, model, started_at) VALUES ('s', 'old-model', 1700000000)").run();
      const insert = db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s', ?, ?, ?)");
      for (let id = 1; id <= count; id++) insert.run(id % 2 ? "user" : "assistant", `Message ${id}`, 1700000000 + id);
    } finally { db.close(); }
  };

  it("keeps the held page unchanged when polling after loading older history", () => {
    populate();
    const newest = hermesConversationPage("s", dbPath);
    hermesConversationPage("s", dbPath, { before: newest.cursor! });
    const polled = hermesConversationPage("s", dbPath, { from: newest.cursor! });
    expect(polled.turns).toEqual(newest.turns);
    expect(polled.cursor).toBe(newest.cursor);
    expect(hermesConversationPage("s", dbPath, { from: newest.cursor! }).version).toBe(polled.version);
  });

  it("returns the newest page after appends and fills the gap back to the held start", () => {
    populate();
    const initial = hermesConversationPage("s", dbPath);
    const db = new Database(dbPath);
    try {
      const insert = db.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s', ?, ?, ?)");
      for (let id = 151; id <= 350; id++) insert.run(id % 2 ? "user" : "assistant", `Message ${id}`, 1700000000 + id);
    } finally { db.close(); }
    const newest = hermesConversationPage("s", dbPath, { from: initial.cursor! });
    expect(newest.turns[0]!.parts).toEqual([{ kind: "text", text: "Message 251" }]);
    expect(newest.turns.at(-1)!.parts).toEqual([{ kind: "text", text: "Message 350" }]);
    const between = hermesConversationPage("s", dbPath, { before: newest.cursor!, since: initial.cursor! });
    const first = hermesConversationPage("s", dbPath, { before: between.cursor!, since: initial.cursor! });
    expect(first.cursor).toBe(initial.cursor);
    expect([...first.turns, ...between.turns, ...newest.turns].flatMap(turn => turn.parts).map(part => part.kind === "text" ? part.text : ""))
      .toEqual(Array.from({ length: 300 }, (_, index) => `Message ${index + 51}`));
  });

  it("refuses foreign, missing and reversed cursor positions", () => {
    populate();
    const newest = hermesConversationPage("s", dbPath);
    const prefix = `${newest.history_id}:`;
    for (const page of [
      { before: newest.cursor!, since: "hermes:another-session:1" },
      { from: `${prefix}-1` },
      { from: `${prefix}9999` },
      { before: newest.cursor!, since: `${prefix}101` },
      { before: newest.cursor!, since: `${prefix}not-a-number` },
    ]) expect(() => hermesConversationPage("s", dbPath, page)).toThrow(HistoryChanged);
  });

  it("keeps a tool call and its result together at a page boundary", () => {
    populate();
    const db = new Database(dbPath);
    try {
      db.query("UPDATE messages SET content = NULL, tool_calls = ? WHERE id = 50").run(JSON.stringify([
        { id: "boundary-call", function: { name: "bash", arguments: '{"command":"echo example"}' } },
      ]));
      db.query("UPDATE messages SET role = 'tool', content = 'example', tool_call_id = 'boundary-call', tool_name = 'bash' WHERE id = 51").run();
    } finally { db.close(); }
    const newest = hermesConversationPage("s", dbPath);
    const older = hermesConversationPage("s", dbPath, { before: newest.cursor! });
    const tools = [...older.turns, ...newest.turns].flatMap(turn => turn.parts).filter(part => part.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "bash", summary: "echo example", output: "example" });
  });

  it("refreshes metadata and edited messages while a WAL writer stays open", () => {
    populate(2);
    const db = new Database(dbPath);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
      const before = hermesConversationPage("s", dbPath);
      const stat = statSync(dbPath);
      db.query("UPDATE sessions SET model = 'new-model' WHERE id = 's'").run();
      const metadata = hermesConversationPage("s", dbPath);
      expect(statSync(dbPath).mtimeMs).toBe(stat.mtimeMs);
      expect(statSync(dbPath).size).toBe(stat.size);
      expect(metadata.metadata.model).toBe("new-model");
      expect(metadata.version).not.toBe(before.version);
      db.query("UPDATE messages SET content = 'Edited response' WHERE id = 2").run();
      const edited = hermesConversationPage("s", dbPath);
      expect(edited.turns[1]!.parts).toEqual([{ kind: "text", text: "Edited response" }]);
      expect(edited.version).not.toBe(metadata.version);
      expect(edited.history_id).toBe(before.history_id);
    } finally { db.close(); }
  });

  it("reads nested reasoning settings and omits cumulative session usage", () => {
    populate(2);
    const db = new Database(dbPath);
    try {
      db.query("UPDATE sessions SET model_config = ?, input_tokens = 1000000, output_tokens = 100000 WHERE id = 's'")
        .run(JSON.stringify({ reasoning_config: { enabled: true, effort: "high" } }));
      expect(hermesConversationPage("s", dbPath).metadata).toEqual({ model: "old-model", reasoning_effort: "high" });
      db.query("UPDATE sessions SET model_config = ? WHERE id = 's'").run(JSON.stringify({ reasoning_config: { enabled: false } }));
      expect(hermesConversationPage("s", dbPath).metadata.reasoning_effort).toBe("off");
    } finally { db.close(); }
  });

  it("loads a whole tool result only from the selected session", () => {
    populate(2);
    const db = new Database(dbPath);
    const output = "tool result ".repeat(500);
    try {
      db.query("INSERT INTO messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, 'tool', ?, 'shared-call', 1700000003)").run("s", output);
      db.query("INSERT INTO messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, 'tool', ?, 'shared-call', 1700000004)").run("another-session", "Another pane's output");
    } finally { db.close(); }
    expect(hermesToolOutput("s", dbPath, "shared-call", 2_000_000)).toBe(output);
    expect(hermesToolOutput("s", dbPath, "missing-call", 2_000_000)).toBeNull();
    expect(hermesToolOutput("s", dbPath, "shared-call", 20)).toBe(output.slice(0, 20));
  });

  it("changes history identity and refuses held cursors after database replacement", () => {
    populate();
    const before = hermesConversationPage("s", dbPath);
    const replacement = join(tempDir, "replacement.db");
    copyFileSync(dbPath, replacement);
    renameSync(replacement, dbPath);
    const after = hermesConversationPage("s", dbPath);
    expect(after.history_id).not.toBe(before.history_id);
    expect(() => hermesConversationPage("s", dbPath, { from: before.cursor! })).toThrow(HistoryChanged);
  });
});
