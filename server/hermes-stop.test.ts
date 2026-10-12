import { describe, expect, it, jest } from "bun:test";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { HermesStops } from "./hermes-stop.ts";

function fixture() {
  let now = 0;
  let current: HerdrPane | null = {
    pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", focused: false,
    revision: 0, agent: "hermes", agent_status: "working",
    agent_session: { agent: "hermes", kind: "id", source: "test", value: "session1" },
  };
  let queueGate: Promise<void> = Promise.resolve();
  let writeGate: Promise<void> = Promise.resolve();
  let read: (() => Promise<HerdrPane | null>) | null = null;
  let failedWrite = false;
  const keys: string[] = [];
  const stops = new HermesStops({
    now: () => now,
    readPane: async () => read ? read() : current ? { ...current } : null,
    serialize: async (_pane, task) => { await queueGate; return task(); },
    interrupt: async (_pane, guard) => {
      await writeGate;
      if (guard()) {
        keys.push("ctrl+c");
        if (failedWrite) throw new Error("response lost after write");
      }
    },
  });
  const status = (value: AgentStatus) => {
    if (current) current = { ...current, agent_status: value };
    stops.status("p1", value, current?.agent ?? null);
  };
  const token = async () => {
    const response = await stops.get("p1");
    expect(response.state).toBe("available");
    return response.turn_id!;
  };
  return {
    stops, keys, status, token,
    advance: (ms: number) => { now += ms; },
    snapshot: () => current ? { ...current } : null,
    replace: (patch: Partial<HerdrPane>) => { current = { ...current!, ...patch }; },
    queue: (promise: Promise<void>) => { queueGate = promise; },
    write: (promise: Promise<void>) => { writeGate = promise; },
    read: (callback: (() => Promise<HerdrPane | null>) | null) => { read = callback; },
    failWrite: () => { failedWrite = true; },
  };
}

const signal = () => new AbortController().signal;

describe("Hermes Stop observed turns", () => {
  it("waits out the native startup window and never offers idle, blocked, unknown or another agent", async () => {
    const f = fixture();
    expect((await f.stops.get("p1")).state).toBe("unavailable");
    f.advance(2_499);
    expect((await f.stops.get("p1")).state).toBe("unavailable");
    f.advance(1);
    const id = await f.token();
    for (const state of ["unknown", "blocked", "idle"] as const) {
      f.status(state);
      expect((await f.stops.get("p1")).state).toBe("unavailable");
      await expect(f.stops.request("p1", id, signal())).rejects.toMatchObject({ code: "hermes_stop_unavailable" });
    }
    f.replace({ agent: "claude" });
    expect((await f.stops.get("p1")).state).toBe("unavailable");
    await expect(f.stops.request("p1", id, signal())).rejects.toMatchObject({ code: "hermes_stop_unavailable" });
    expect(f.keys).toEqual([]);
  });

  it("claims across concurrent clients before waiting for serialization and awaits the original attempt", async () => {
    const f = fixture(); f.advance(2_500);
    const id = await f.token();
    const gate = Promise.withResolvers<void>(); f.queue(gate.promise);
    let returned = false;
    const original = f.stops.request("p1", id, signal()).then((response) => { returned = true; return response; });
    const duplicates = await Promise.all(Array.from({ length: 12 }, () => f.stops.request("p1", id, signal())));
    expect(duplicates.every((response) => response.state === "stopping")).toBe(true);
    expect(returned).toBe(false);
    expect((await f.stops.get("p1")).state).toBe("stopping");
    expect(f.keys).toEqual([]);
    gate.resolve();
    expect((await original).state).toBe("stopping");
    expect(f.keys).toEqual(["ctrl+c"]);
    await f.stops.request("p1", id, signal());
    expect(f.keys).toEqual(["ctrl+c"]);
  });

  it("does not confuse receipt, blocked or unknown with completion or retry an uncertain write", async () => {
    const f = fixture(); f.advance(2_500); f.failWrite();
    const id = await f.token();
    expect((await f.stops.request("p1", id, signal())).state).toBe("unconfirmed");
    for (const state of ["unknown", "blocked", "working"] as const) {
      f.status(state);
      expect((await f.stops.request("p1", id, signal())).state).toBe("unconfirmed");
    }
    expect(f.keys).toEqual(["ctrl+c"]);
    f.status("idle");
    expect((await f.stops.get("p1")).state).toBe("stopped");
  });

  it("keeps blocked-to-working in one cycle and requires ready before a new token, with a cross-turn cooldown", async () => {
    const f = fixture(); f.advance(2_500);
    const first = await f.token();
    f.status("blocked"); f.status("working");
    expect(await f.token()).toBe(first);
    await f.stops.request("p1", first, signal());
    f.status("done");
    expect((await f.stops.get("p1")).state).toBe("stopped");
    f.status("working");
    expect((await f.stops.get("p1")).state).toBe("unavailable");
    await expect(f.stops.request("p1", first, signal())).rejects.toMatchObject({ code: "hermes_stop_changed" });
    f.advance(2_499);
    expect((await f.stops.get("p1")).state).toBe("unavailable");
    f.advance(1);
    const second = await f.token();
    expect(second).not.toBe(first);
    await f.stops.request("p1", second, signal());
    expect(f.keys).toEqual(["ctrl+c", "ctrl+c"]);
  });

  it("expires a queued action without a later interrupt and retains the consumed token", async () => {
    const f = fixture(); f.advance(2_500);
    const id = await f.token();
    const gate = Promise.withResolvers<void>(); f.queue(gate.promise);
    const request = f.stops.request("p1", id, signal());
    await f.stops.request("p1", id, signal());
    f.advance(10_000);
    expect((await f.stops.get("p1")).state).toBe("unconfirmed");
    gate.resolve();
    expect((await request).state).toBe("unconfirmed");
    await f.stops.request("p1", id, signal());
    expect(f.keys).toEqual([]);
  });

  it("returns unconfirmed at the bounded deadline even while serialization is still blocked", async () => {
    jest.useFakeTimers();
    const f = fixture(); f.advance(2_500);
    const gate = Promise.withResolvers<void>(); f.queue(gate.promise);
    try {
      const id = await f.token();
      const request = f.stops.request("p1", id, signal());
      await f.stops.request("p1", id, signal());
      f.advance(10_000);
      jest.advanceTimersByTime(10_000);
      expect((await request).state).toBe("unconfirmed");
      expect(f.keys).toEqual([]);
      gate.resolve();
      await Promise.resolve(); await Promise.resolve();
      expect((await f.stops.request("p1", id, signal())).state).toBe("unconfirmed");
      expect(f.keys).toEqual([]);
    } finally {
      f.stops.close(); gate.resolve(); jest.useRealTimers();
    }
  });

  it("retires stale session tokens without reopening a consumed Stop on the same terminal", async () => {
    const f = fixture(); f.advance(2_500);
    const first = await f.token();
    await f.stops.request("p1", first, signal());
    f.advance(3_000);
    for (const session of [null, { agent: "hermes", kind: "id", source: "native", value: "discovered-session" }]) {
      f.replace({ agent_session: session });
      expect((await f.stops.get("p1")).state).toBe("unavailable");
      await expect(f.stops.request("p1", first, signal())).rejects.toMatchObject({ code: "hermes_stop_changed" });
      f.status("unknown"); f.status("blocked"); f.status("working");
      expect((await f.stops.get("p1")).state).toBe("unavailable");
    }
    expect(f.keys).toEqual(["ctrl+c"]);
    f.status("idle"); f.status("working");
    const next = await f.token();
    expect(next).not.toBe(first);
    await f.stops.request("p1", next, signal());
    expect(f.keys).toEqual(["ctrl+c", "ctrl+c"]);
  });

  for (const change of ["abort", "shutdown", "idle", "unknown", "blocked", "terminal", "session", "agent"] as const) {
    it(`cancels immediately before the actual write on ${change}`, async () => {
      const f = fixture(); f.advance(2_500);
      const id = await f.token();
      const gate = Promise.withResolvers<void>(); f.write(gate.promise);
      const controller = new AbortController();
      const request = f.stops.request("p1", id, controller.signal);
      await f.stops.request("p1", id, signal());
      // Let the fresh target read finish and the RPC connect reach its guarded write.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      if (change === "abort") controller.abort();
      else if (change === "shutdown") f.stops.close();
      else if (change === "terminal") { f.replace({ terminal_id: "t2" }); await f.stops.get("p1"); }
      else if (change === "session") { f.replace({ agent_session: { agent: "hermes", kind: "id", source: "test", value: "session2" } }); await f.stops.get("p1"); }
      else if (change === "agent") f.stops.status("p1", "working", "claude");
      else f.status(change);
      gate.resolve();
      await request;
      expect(f.keys).toEqual([]);
    });
  }

  it("fresh-checks the target after waiting in the input queue", async () => {
    const f = fixture(); f.advance(2_500);
    const id = await f.token();
    const gate = Promise.withResolvers<void>(); f.queue(gate.promise);
    const request = f.stops.request("p1", id, signal());
    await f.stops.request("p1", id, signal());
    f.replace({ terminal_id: "replacement" });
    gate.resolve(); await request;
    expect(f.keys).toEqual([]);
    await expect(f.stops.request("p1", id, signal())).rejects.toMatchObject({ code: "hermes_stop_changed" });
  });

  it("never lets an older HTTP read rewind a status event", async () => {
    const f = fixture(); f.advance(2_500);
    const id = await f.token();
    const read = Promise.withResolvers<HerdrPane | null>();
    const old = f.snapshot(); f.read(() => read.promise);
    const request = f.stops.request("p1", id, signal());
    f.status("idle"); read.resolve(old);
    await expect(request).rejects.toMatchObject({ code: "hermes_stop_unavailable" });
    expect(f.keys).toEqual([]);
  });

  it("does not let an in-flight collector snapshot confirm a newer claim or resurrect an ended pane", async () => {
    const f = fixture(); f.advance(2_500);
    const id = await f.token();
    const old = { ...f.snapshot()!, agent_status: "idle" };
    const read = Promise.withResolvers<SessionSnapshot>();
    const snapshot = f.stops.snapshot(() => read.promise);
    await f.stops.request("p1", id, signal());
    read.resolve({ panes: [old] } as SessionSnapshot);
    f.stops.reconcile((await snapshot).panes);
    expect((await f.stops.get("p1")).state).toBe("stopping");
    const endedRead = Promise.withResolvers<SessionSnapshot>();
    const endedSnapshot = f.stops.snapshot(() => endedRead.promise);
    f.stops.ended("p1");
    endedRead.resolve({ panes: [f.snapshot()!] } as SessionSnapshot);
    f.stops.reconcile((await endedSnapshot).panes);
    f.read(async () => null);
    expect((await f.stops.get("p1")).state).toBe("stopped");
    expect(f.keys).toEqual(["ctrl+c"]);
  });
});
