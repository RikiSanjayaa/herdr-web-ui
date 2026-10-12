import { randomUUID } from "node:crypto";
import type { AgentStatus, HerdrPane, HermesStopResponse, SessionSnapshot } from "../shared/protocol.ts";

const COOLDOWN_MS = 2_500;
const CONFIRM_MS = 10_000;

type Identity = { terminal: string; session: string | null; agent: string | null };
type Turn = { id: string; ready: boolean; claimedAt: number | null; attempted: boolean; unconfirmed: boolean; stopped: boolean };
type ObservedPane = { identity: Identity | null; agent: string | null; status: AgentStatus; turn: Turn | null; revision: number; ended: boolean; interruptAt: number | null; consumedTerminal: string | null };

export class HermesStopError extends Error {
  constructor(public readonly code: "hermes_stop_changed" | "hermes_stop_unavailable", message: string) { super(message); }
}

interface Dependencies {
  readPane: (paneId: string) => Promise<HerdrPane | null>;
  serialize: <T>(paneId: string, task: () => Promise<T>) => Promise<T>;
  /** Must invoke guard immediately before the actual RPC write, not just before connecting. */
  interrupt: (paneId: string, guard: () => boolean) => Promise<void>;
  now?: () => number;
}

const identityOf = (pane: HerdrPane): Identity => ({
  terminal: pane.terminal_id,
  session: pane.agent_session ? `${pane.agent_session.kind}:${pane.agent_session.source}:${pane.agent_session.value}` : null,
  agent: pane.agent ?? pane.agent_session?.agent ?? null,
});
const sameIdentity = (a: Identity | null, b: Identity): boolean => a !== null && a.terminal === b.terminal && a.session === b.session && a.agent === b.agent;
const ready = (status: AgentStatus): boolean => status === "idle" || status === "done";

/** One bridge's observed Hermes work cycles and consumed Stop claims, independent of browser connections. */
export class HermesStops {
  private readonly panes = new Map<string, ObservedPane>();
  private readonly snapshotRevisions = new WeakMap<HerdrPane, number>();
  private readonly now: () => number;
  private readonly startedAt: number;
  private closed = false;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
  }

  private pane(paneId: string): ObservedPane {
    let pane = this.panes.get(paneId);
    if (!pane) {
      pane = { identity: null, agent: null, status: "unknown", turn: null, revision: 0, ended: false, interruptAt: null, consumedTerminal: null };
      this.panes.set(paneId, pane);
    }
    return pane;
  }

  private advance(pane: ObservedPane, status: AgentStatus): void {
    pane.status = status;
    if (pane.agent !== "hermes" || !pane.identity || pane.ended) return;
    if (ready(status)) {
      pane.consumedTerminal = null;
      if (pane.turn) {
        pane.turn.ready = true;
        if (pane.turn.claimedAt !== null) pane.turn.stopped = true;
      }
    } else if (status === "working" && (!pane.turn || pane.turn.ready) && pane.consumedTerminal !== pane.identity.terminal) {
      pane.turn = { id: randomUUID(), ready: false, claimedAt: null, attempted: false, unconfirmed: false, stopped: false };
    }
    // Unknown and blocked never retire a consumed claim or establish a new work cycle.
  }

  /** Raw collector events, before any completion/status normalization. */
  status(paneId: string, status: AgentStatus, agent: string | null): void {
    const pane = this.pane(paneId);
    pane.revision++;
    if (pane.agent !== agent) { pane.identity = null; pane.turn = null; }
    pane.agent = agent;
    this.advance(pane, status);
  }

  /** Only ordered collector snapshots (onReconciled or onResync excluding newer panes). */
  reconcile(panes: readonly HerdrPane[], newer: ReadonlySet<string> = new Set()): void {
    for (const snapshot of panes) {
      const revision = this.snapshotRevisions.get(snapshot);
      if (!newer.has(snapshot.pane_id) && (revision === undefined || revision === this.pane(snapshot.pane_id).revision)) this.observe(snapshot);
    }
  }

  /** Capture ordering when the collector starts its existing snapshot, not when it arrives. */
  async snapshot(read: () => Promise<SessionSnapshot>): Promise<SessionSnapshot> {
    const revisions = new Map([...this.panes].map(([paneId, pane]) => [paneId, pane.revision]));
    const snapshot = await read();
    for (const pane of snapshot.panes) this.snapshotRevisions.set(pane, revisions.get(pane.pane_id) ?? 0);
    return snapshot;
  }

  private observe(snapshot: HerdrPane): void {
    const pane = this.pane(snapshot.pane_id);
    const identity = identityOf(snapshot);
    if (!sameIdentity(pane.identity, identity) || pane.ended) pane.turn = null;
    // Session metadata discovery retires the token, not the terminal's consumed interrupt.
    if (pane.consumedTerminal !== identity.terminal) pane.consumedTerminal = null;
    pane.identity = identity;
    pane.agent = identity.agent;
    pane.ended = false;
    pane.revision++;
    this.advance(pane, snapshot.agent_status);
  }

  ended(paneId: string): void {
    const pane = this.pane(paneId);
    pane.revision++;
    pane.ended = true;
    pane.consumedTerminal = null;
    if (pane.turn) {
      pane.turn.ready = true;
      if (pane.turn.claimedAt !== null) pane.turn.stopped = true;
    }
    pane.status = "done";
  }

  private cooled(pane: ObservedPane): boolean {
    return this.now() - Math.max(this.startedAt, pane.interruptAt ?? this.startedAt) >= COOLDOWN_MS;
  }

  private response(paneId: string): HermesStopResponse {
    const pane = this.pane(paneId);
    const turn = pane.turn;
    if (turn?.claimedAt !== null && turn?.claimedAt !== undefined) {
      return { pane_id: paneId, turn_id: turn.id, state: turn.stopped ? "stopped" : turn.unconfirmed || this.now() - turn.claimedAt >= CONFIRM_MS ? "unconfirmed" : "stopping" };
    }
    const available = !this.closed && pane.agent === "hermes" && !pane.ended && pane.status === "working" && !!pane.identity?.terminal && !!turn && !turn.ready && this.cooled(pane);
    return { pane_id: paneId, turn_id: available ? turn!.id : null, state: available ? "available" : "unavailable" };
  }

  private async fresh(paneId: string): Promise<HerdrPane | null> {
    const pane = this.pane(paneId);
    const revision = pane.revision;
    const snapshot = await this.deps.readPane(paneId);
    // A read already in flight is never allowed to rewind a newer event, end or identity read.
    if (pane.revision === revision) {
      if (snapshot) this.observe(snapshot);
      else this.ended(paneId);
    }
    return snapshot;
  }

  async get(paneId: string): Promise<HermesStopResponse> {
    await this.fresh(paneId);
    return this.response(paneId);
  }

  async request(paneId: string, turnId: string, signal: AbortSignal): Promise<HermesStopResponse> {
    const snapshot = await this.fresh(paneId);
    const pane = this.pane(paneId);
    if (pane.agent !== "hermes" || !snapshot || identityOf(snapshot).agent !== "hermes") {
      throw new HermesStopError("hermes_stop_unavailable", "This pane has no observed working Hermes turn");
    }
    const turn = pane.turn;
    if (!turn || turn.id !== turnId) throw new HermesStopError("hermes_stop_changed", "The Hermes turn or terminal changed; review its current state");
    if (turn.claimedAt !== null) return this.response(paneId);
    if (signal.aborted || !sameIdentity(pane.identity, identityOf(snapshot)) || snapshot.agent_status !== "working" || this.response(paneId).state !== "available") {
      throw new HermesStopError("hermes_stop_unavailable", "Hermes Stop is not available for this turn");
    }
    // Claim before scheduling anything. Even an uncertain write or lost HTTP response consumes it.
    turn.claimedAt = this.now();
    pane.consumedTerminal = pane.identity!.terminal;
    pane.revision++;
    const run = this.deps.serialize(paneId, async () => {
      const allowed = (): boolean => !this.closed && !signal.aborted && pane.turn === turn && !pane.ended && !turn.ready && !turn.attempted
        && !turn.unconfirmed && this.now() - turn.claimedAt! < CONFIRM_MS && pane.agent === "hermes" && pane.status === "working" && this.cooled(pane);
      if (!allowed()) return;
      const current = await this.fresh(paneId);
      if (!current || current.agent_status !== "working" || !sameIdentity(pane.identity, identityOf(current)) || !allowed()) return;
      await this.deps.interrupt(paneId, () => {
        if (!allowed()) return false;
        // The RPC may fail after its write. Neither that failure nor a later POST can retry.
        turn.attempted = true;
        pane.interruptAt = this.now();
        return true;
      });
    }).catch(() => { if (!turn.stopped) turn.unconfirmed = true; });
    let timer: Timer | undefined;
    let aborted: (() => void) | undefined;
    const expired = new Promise<void>((resolve) => {
      const expire = (): void => { if (!turn.stopped) turn.unconfirmed = true; resolve(); };
      timer = setTimeout(expire, CONFIRM_MS);
      aborted = expire;
      signal.addEventListener("abort", expire, { once: true });
      if (signal.aborted) expire();
    });
    try { await Promise.race([run, expired]); }
    finally {
      clearTimeout(timer);
      if (aborted) signal.removeEventListener("abort", aborted);
    }
    return this.response(paneId);
  }

  close(): void { this.closed = true; }
}
