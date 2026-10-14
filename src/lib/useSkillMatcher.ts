import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { cachedPaneCommands, paneCommandRevision, subscribePaneCommands } from "./paneCommandCache.ts";
import { createSkillMatcher, type SkillMatcher } from "./skillMentions.ts";

/** The pane's skill names as a matcher, from its command list; null until it loads, or when it fails. */
export function useSkillMatcher(paneId: string, agent: string | null, cwd: string | null, connected: boolean): SkillMatcher | null {
  const { fetchPaneCommands } = useMachineApi();
  const machineId = useMachineId();
  const subscribe = useCallback((listener: () => void) => subscribePaneCommands(paneId, machineId, listener), [paneId, machineId]);
  const snapshot = useCallback(() => paneCommandRevision(paneId, machineId), [paneId, machineId]);
  const revision = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [loaded, setLoaded] = useState<{ paneId: string; machineId: string; agent: string | null; cwd: string | null; revision: number; matcher: SkillMatcher | null } | null>(null);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const scope = { paneId, machineId, agent, cwd, revision };
    cachedPaneCommands(paneId, machineId, fetchPaneCommands, agent, cwd).then(
      (commands) => { if (live) setLoaded({ ...scope, matcher: createSkillMatcher(commands) }); },
      () => { if (live) setLoaded({ ...scope, matcher: null }); },
    );
    return () => { live = false; };
  }, [fetchPaneCommands, paneId, machineId, agent, cwd, revision, connected]);
  return connected && loaded?.paneId === paneId && loaded.machineId === machineId && loaded.agent === agent && loaded.cwd === cwd && loaded.revision === revision ? loaded.matcher : null;
}
