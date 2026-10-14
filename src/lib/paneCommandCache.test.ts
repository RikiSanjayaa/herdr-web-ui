import { expect, test } from "bun:test";
import type { SlashCommand } from "../../shared/protocol.ts";
import { cachedPaneCommands, cancelPaneCommandRequests, invalidatePaneCommands, paneCommandRevision, subscribePaneCommands } from "./paneCommandCache.ts";

/** Build a one-skill inventory whose name distinguishes fresh results from stale reads. */
const commands = (name: string): SlashCommand[] => [{ name, description: "Fictional skill", source: "skill" }];
/** Fail any fetch attempted when the test expects the current inventory to come from cache. */
const unexpectedRead = async (): Promise<SlashCommand[]> => { throw new Error("the current inventory should be cached"); };

test("a late pre-reload read cannot replace the shared refreshed inventory", async () => {
  const old = Promise.withResolvers<SlashCommand[]>();
  const pending = cachedPaneCommands("reload", "local", () => old.promise, "hermes", "/project");
  const fresh = commands("new-skill");
  await cachedPaneCommands("reload", "local", async () => fresh, "hermes", "/project", true);
  old.resolve(commands("removed-skill"));
  await pending;
  expect(await cachedPaneCommands("reload", "local", unexpectedRead, "hermes", "/project")).toEqual(fresh);
});

test("an abandoned read cannot supply commands after reconnect", async () => {
  const old = Promise.withResolvers<SlashCommand[]>();
  const pending = cachedPaneCommands("reconnect", "local", () => old.promise, "hermes", "/project");
  cancelPaneCommandRequests("reconnect", "local");
  old.resolve(commands("disconnected-skill"));
  await pending;
  const fresh = commands("reconnected-skill");
  expect(await cachedPaneCommands("reconnect", "local", async () => fresh, "hermes", "/project")).toEqual(fresh);
});

test("agent and cwd transitions do not reuse another native scope's commands", async () => {
  const first = commands("hermes-first");
  await cachedPaneCommands("scope", "local", async () => first, "hermes", "/first");
  const otherAgent = commands("claude-first");
  expect(await cachedPaneCommands("scope", "local", async () => otherAgent, "claude", "/first")).toEqual(otherAgent);
  const otherCwd = commands("claude-second");
  expect(await cachedPaneCommands("scope", "local", async () => otherCwd, "claude", "/second")).toEqual(otherCwd);
});

test("a late abandoned scope cannot replace commands when that scope is revisited", async () => {
  const old = Promise.withResolvers<SlashCommand[]>();
  const pending = cachedPaneCommands("revisit", "local", () => old.promise, "hermes", "/first");
  const second = commands("second-project");
  await cachedPaneCommands("revisit", "local", async () => second, "hermes", "/second");
  old.resolve(commands("stale-first-project"));
  await pending;
  expect(await cachedPaneCommands("revisit", "local", unexpectedRead, "hermes", "/second")).toEqual(second);
  const fresh = commands("current-first-project");
  expect(await cachedPaneCommands("revisit", "local", async () => fresh, "hermes", "/first")).toEqual(fresh);
});

test("equal pane IDs on different PCs and different panes on one PC retain separate inventories", async () => {
  const local = commands("local-skill");
  const remote = commands("remote-skill");
  const sibling = commands("sibling-skill");
  await cachedPaneCommands("shared-id", "local", async () => local, "hermes", "/project");
  await cachedPaneCommands("shared-id", "remote", async () => remote, "hermes", "/project");
  await cachedPaneCommands("sibling", "local", async () => sibling, "hermes", "/project");
  invalidatePaneCommands("shared-id", "local");
  expect(await cachedPaneCommands("shared-id", "remote", unexpectedRead, "hermes", "/project")).toEqual(remote);
  expect(await cachedPaneCommands("sibling", "local", unexpectedRead, "hermes", "/project")).toEqual(sibling);
});

test("native reload invalidation lets a skill matcher read the new inventory without affecting another pane", async () => {
  await cachedPaneCommands("matcher", "local", async () => commands("removed-skill"), "hermes", "/project");
  const fresh = commands("added-skill");
  let refreshed: Promise<SlashCommand[]> | undefined;
  const unsubscribe = subscribePaneCommands("matcher", "local", () => {
    refreshed = cachedPaneCommands("matcher", "local", async () => fresh, "hermes", "/project");
  });
  try {
    const before = paneCommandRevision("matcher", "local");
    invalidatePaneCommands("other-matcher", "local");
    expect(paneCommandRevision("matcher", "local")).toBe(before);
    expect(refreshed).toBeUndefined();
    invalidatePaneCommands("matcher", "local");
    expect(await refreshed).toEqual(fresh);
    expect(await cachedPaneCommands("matcher", "local", unexpectedRead, "hermes", "/project")).toEqual(fresh);
  } finally { unsubscribe(); }
});
