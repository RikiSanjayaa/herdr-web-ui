import { paneStorageId } from "../../shared/machines.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

const COMMAND_CACHE_MS = 60_000;
const cache = new Map<string, { loadedAt: number; commands: SlashCommand[]; agent: string | null; cwd: string | null }>();
const requests = new Map<string, object>();
const revisions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

/** Read the PC-scoped pane's invalidation counter; a pane never invalidated starts at zero. */
export function paneCommandRevision(paneId: string, machineId: string): number {
  return revisions.get(paneStorageId(machineId, paneId)) ?? 0;
}

/** Listen for synchronous inventory invalidations on one PC/pane pair; return a subscription cleanup. */
export function subscribePaneCommands(paneId: string, machineId: string, listener: () => void): () => void {
  const key = paneStorageId(machineId, paneId);
  let subscribers = listeners.get(key);
  if (!subscribers) listeners.set(key, subscribers = new Set());
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(key);
  };
}

/** A read abandoned on disconnect or scope change must not refill the cache. */
export function cancelPaneCommandRequests(paneId: string, machineId: string): void {
  requests.delete(paneStorageId(machineId, paneId));
}

/** A successful native reload invalidates both suggestions and transcript skill matching. */
export function invalidatePaneCommands(paneId: string, machineId: string): void {
  const key = paneStorageId(machineId, paneId);
  cache.delete(key);
  requests.delete(key);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  const subscribers = listeners.get(key);
  if (subscribers) for (const listener of subscribers) listener();
}

/** The menu and skill chips share an inventory scoped to the selected PC, pane, agent and cwd. */
export async function cachedPaneCommands(
  paneId: string,
  machineId: string,
  fetchCommands: (pane: string) => Promise<SlashCommand[]>,
  agent: string | null,
  cwd: string | null,
  refresh = false,
): Promise<SlashCommand[]> {
  if (refresh) invalidatePaneCommands(paneId, machineId);
  const key = paneStorageId(machineId, paneId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.loadedAt < COMMAND_CACHE_MS && cached.agent === agent && cached.cwd === cwd) return cached.commands;
  const request = {};
  requests.set(key, request);
  try {
    const commands = await fetchCommands(paneId);
    if (requests.get(key) === request) cache.set(key, { loadedAt: Date.now(), commands, agent, cwd });
    return commands;
  } finally {
    if (requests.get(key) === request) requests.delete(key);
  }
}
