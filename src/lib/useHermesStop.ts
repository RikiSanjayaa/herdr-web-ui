import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AgentStatus } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import { HermesStopGuard } from "./hermesStop.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";

/** Only mounted, visible, connected Hermes Chat gets status polls. No POST is replayed. */
export function useHermesStop(paneId: string | null, enabled: boolean, agentStatus: AgentStatus | undefined) {
  const machineId = useMachineId();
  const { fetchHermesStop, requestHermesStop } = useMachineApi();
  const guard = useMemo(() => new HermesStopGuard(paneId ?? ""), [machineId, paneId]);
  const [, publish] = useReducer((value: number) => value + 1, 0);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const statusRef = useRef(agentStatus);
  statusRef.current = agentStatus;
  const lastStatusRef = useRef(agentStatus);
  const actionRef = useRef<(() => void) | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  useEffect(() => {
    guard.suspend();
    publish();
    if (!enabled || !visible || paneId === null) return;
    let live = true;
    let polling = false;
    let refreshWanted = false;
    let timer: number | undefined;
    let read: AbortController | null = null;
    let post: AbortController | null = null;
    let postTimeout: number | undefined;

    const poll = async (): Promise<void> => {
      if (!live) return;
      if (polling) { refreshWanted = true; return; }
      window.clearTimeout(timer);
      polling = true;
      const controller = new AbortController();
      read = controller;
      const deadline = window.setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetchHermesStop(paneId, controller.signal);
        if (live) guard.observe(response, Date.now());
      } catch (error) {
        if (live) guard.readFailed(error instanceof ApiError && (error.status === 404 || error.status === 405));
      } finally {
        window.clearTimeout(deadline);
        if (read === controller) read = null;
        polling = false;
        if (live) {
          guard.expire(Date.now());
          publish();
          // An old bridge cannot gain the endpoint during this connection. Reconnect
          // and remount both probe again; don't keep requesting a known missing route.
          if (guard.state !== "unsupported") {
            const delay = refreshWanted ? 0 : guard.state === "stopping" ? 500 : statusRef.current === "working" ? 2000 : 10_000;
            refreshWanted = false;
            timer = window.setTimeout(() => { void poll(); }, delay);
          }
        }
      }
    };

    actionRef.current = () => {
      if (!live || post !== null || statusRef.current !== "working" || document.visibilityState !== "visible") return;
      // The ref action claims synchronously, before publish/await: clicks and held
      // Escape share the same consumed token even before React paints Stopping.
      const turnId = guard.claim(Date.now());
      if (turnId === null) return;
      publish();
      const controller = new AbortController();
      post = controller;
      postTimeout = window.setTimeout(() => {
        controller.abort();
        if (live) { guard.deliveryUnknown(turnId); publish(); }
      }, 10_000);
      void requestHermesStop({ pane_id: paneId, turn_id: turnId }, controller.signal).then((response) => {
        if (live && guard.turnId === turnId) {
          if (response.state === "unavailable") guard.deliveryUnknown(turnId);
          guard.observe(response, Date.now());
        }
      }).catch(() => {
        if (live) guard.deliveryUnknown(turnId);
      }).finally(() => {
        if (post === controller) {
          post = null;
          window.clearTimeout(postTimeout);
          postTimeout = undefined;
        }
        if (live) { publish(); void poll(); }
      });
      void poll();
    };
    refreshRef.current = () => { void poll(); };
    void poll();
    return () => {
      live = false;
      actionRef.current = null;
      refreshRef.current = null;
      window.clearTimeout(timer);
      window.clearTimeout(postTimeout);
      read?.abort();
      post?.abort();
      guard.suspend();
    };
  }, [enabled, visible, paneId, guard, fetchHermesStop, requestHermesStop]);

  useEffect(() => {
    if (lastStatusRef.current === agentStatus) return;
    lastStatusRef.current = agentStatus;
    refreshRef.current?.();
  }, [agentStatus]);
  const stop = useCallback(() => { actionRef.current?.(); }, []);
  return { state: guard.state, canStop: enabled && visible && guard.canStop, stop };
}
