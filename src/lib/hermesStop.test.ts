import { expect, it } from "bun:test";
import type { HermesStopResponse } from "../../shared/protocol.ts";
import { HermesStopGuard } from "./hermesStop.ts";

const observed = (state: HermesStopResponse["state"], turnId: string | null = "turn-a"): HermesStopResponse => ({ pane_id: "hermes-pane", turn_id: turnId, state });

it("claims one request before rendering, including held Escape and a stale pre-click GET", () => {
  const guard = new HermesStopGuard("hermes-pane");
  expect(guard.claim(0)).toBeNull();
  guard.observe(observed("available"), 0);
  const requests = [guard.claim(1), guard.claim(1), guard.claim(2)].filter((turn) => turn !== null);
  expect(requests).toEqual(["turn-a"]);
  guard.observe(observed("available"), 3);
  expect(guard.state).toBe("stopping");
  expect(guard.claim(4)).toBeNull();
});

it("requires a fresh GET after reconnect and never reclaims an uncertain turn", () => {
  const guard = new HermesStopGuard("hermes-pane");
  guard.observe(observed("available"), 0);
  guard.suspend();
  expect(guard.claim(1)).toBeNull();
  guard.observe(observed("available"), 2);
  expect(guard.claim(3)).toBe("turn-a");
  guard.suspend();
  expect(guard.state).toBe("unconfirmed");
  guard.observe(observed("available"), 4);
  guard.observe(observed("stopping"), 5);
  expect(guard.state).toBe("unconfirmed");
  expect(guard.claim(6)).toBeNull();
  guard.observe(observed("unavailable", null), 7);
  expect(guard.state).toBe("unconfirmed");
});

it("does not mistake another client's receipt, missing endpoint, or unknown state for permission", () => {
  const guard = new HermesStopGuard("hermes-pane");
  guard.readFailed(true);
  expect(guard.state).toBe("unsupported");
  expect(guard.claim(0)).toBeNull();
  guard.observe(observed("stopping"), 1);
  expect(guard.claim(2)).toBeNull();
  guard.expire(10_001);
  expect(guard.state).toBe("unconfirmed");
  expect(guard.claim(10_002)).toBeNull();
  const fresh = new HermesStopGuard("hermes-pane");
  fresh.observe({ ...observed("available"), pane_id: "different-pane" }, 0);
  expect(fresh.claim(1)).toBeNull();
  fresh.observe({ ...observed("available"), state: "unknown" } as unknown as HermesStopResponse, 0);
  expect(fresh.claim(1)).toBeNull();
});

it("bounds pending, confirms only a server stop, and unlocks only a different observed turn", () => {
  const guard = new HermesStopGuard("hermes-pane");
  guard.observe(observed("available"), 0);
  guard.claim(100);
  guard.expire(10_099);
  expect(guard.state).toBe("stopping");
  guard.expire(10_100);
  expect(guard.state).toBe("unconfirmed");
  guard.observe(observed("stopping"), 10_101);
  expect(guard.state).toBe("unconfirmed");
  guard.observe(observed("stopped"), 10_102);
  guard.deliveryUnknown("turn-a");
  guard.observe(observed("stopping"), 10_103);
  expect(guard.state).toBe("stopped");
  expect(guard.claim(10_104)).toBeNull();
  guard.observe(observed("unavailable", "turn-b"), 10_105);
  expect(guard.claim(10_106)).toBeNull();
  guard.observe(observed("available", "turn-b"), 10_107);
  guard.observe(observed("available", "turn-a"), 10_107);
  expect(guard.turnId).toBe("turn-b");
  expect(guard.claim(10_108)).toBe("turn-b");
  guard.deliveryUnknown("turn-a");
  expect(guard.state).toBe("stopping");
  guard.observe(observed("stopped", "turn-a"), 10_109);
  expect(guard.turnId).toBe("turn-b");
  expect(guard.claim(10_110)).toBeNull();
});

it("refresh after reload respects a server-consumed token without a local click", () => {
  const guard = new HermesStopGuard("hermes-pane");
  guard.observe(observed("unconfirmed"), 0);
  expect(guard.claim(1)).toBeNull();
  guard.observe(observed("available"), 2);
  expect(guard.claim(3)).toBeNull();
  guard.observe(observed("available", "turn-b"), 4);
  expect(guard.claim(5)).toBe("turn-b");
});
