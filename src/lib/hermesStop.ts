import type { HermesStopResponse } from "../../shared/protocol.ts";

export type HermesStopState = HermesStopResponse["state"] | "checking" | "unsupported";

const STOP_STATES: Readonly<Record<string, true | undefined>> = {
  available: true, stopping: true, unconfirmed: true, stopped: true, unavailable: true,
};

/** Local claims close the click/keydown race; the bridge owns cross-client claims. */
export class HermesStopGuard {
  state: HermesStopState = "checking";
  turnId: string | null = null;
  private fresh = false;
  private attemptedTurn: string | null = null;
  private readonly consumedTurns = new Set<string>();
  private deadline: number | null = null;

  constructor(private readonly paneId: string) {}

  get canStop(): boolean {
    return this.fresh && this.state === "available" && this.turnId !== null && !this.consumedTurns.has(this.turnId);
  }

  observe(response: HermesStopResponse, now: number): void {
    if (!response || response.pane_id !== this.paneId
      || (response.turn_id !== null && typeof response.turn_id !== "string")
      || STOP_STATES[response.state] !== true
      || (response.state !== "unavailable" && !response.turn_id)) {
      this.readFailed();
      return;
    }
    // A delayed response from an earlier claimed turn cannot replace a newer token.
    if (response.turn_id !== null && response.turn_id !== this.turnId && this.consumedTurns.has(response.turn_id)) return;
    this.fresh = true;
    const newTurn = response.turn_id !== null && response.turn_id !== this.turnId;
    if (newTurn) {
      this.attemptedTurn = null;
      this.deadline = null;
    }
    if (!newTurn && this.state === "unconfirmed" && response.state === "stopping") return;
    if (!newTurn && this.state === "stopped" && response.state === "stopping") return;
    // A GET started before the POST may still say available. Neither it nor a lost
    // receipt can unlock the claimed token, including after reconnecting.
    if (this.attemptedTurn !== null && !newTurn && response.state !== "stopped"
      && (response.state === "available" || response.state === "unavailable")) {
      this.expire(now);
      return;
    }
    this.turnId = response.turn_id;
    this.state = response.state;
    if (response.turn_id !== null && response.state !== "available" && response.state !== "unavailable") this.consumedTurns.add(response.turn_id);
    if (response.state === "stopping") {
      this.attemptedTurn = response.turn_id;
      this.deadline ??= now + 10_000;
      this.expire(now);
    } else {
      this.deadline = null;
      if (response.state === "unconfirmed" || response.state === "stopped") this.attemptedTurn = response.turn_id;
    }
  }

  /** Synchronous: call before starting any request or scheduling a React update. */
  claim(now: number): string | null {
    if (!this.canStop || this.turnId === null) return null;
    this.attemptedTurn = this.turnId;
    this.consumedTurns.add(this.turnId);
    this.state = "stopping";
    this.deadline = now + 10_000;
    return this.turnId;
  }

  expire(now: number): void {
    if (this.state === "stopping" && this.deadline !== null && now >= this.deadline) {
      this.state = "unconfirmed";
      this.deadline = null;
    }
  }

  deliveryUnknown(turnId: string): void {
    if (this.attemptedTurn !== turnId || this.state === "stopped") return;
    this.state = "unconfirmed";
    this.deadline = null;
  }

  readFailed(unsupported = false): void {
    this.fresh = false;
    if (this.attemptedTurn === null) this.state = unsupported ? "unsupported" : "unavailable";
  }

  suspend(): void {
    this.fresh = false;
    if (this.state === "stopping" && this.attemptedTurn !== null) this.deliveryUnknown(this.attemptedTurn);
  }
}
