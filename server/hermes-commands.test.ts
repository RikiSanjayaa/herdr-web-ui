import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverHermesSkills, hermesCommands, hermesNativeFeatures, readHermesFile, type HermesCommandContext } from "./hermes-commands.ts";
import { paneCommands } from "./commands.ts";

const directories: string[] = [];
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "hermes-discovery-"));
  directories.push(path);
  return path;
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function put(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
function skill(root: string, name: string, description = name, extra = ""): string {
  const dir = join(root, name);
  put(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}\n---\nBody\n`);
  return dir;
}
function context(home = temp()): HermesCommandContext {
  return { home, userHome: home, env: {}, legacy: false, scannerVersion: "test-scanner", coreCommands: new Set(["retry", "status", "reset"]), docker: false, s6: false };
}
function approve(dir: string, ctx: HermesCommandContext, verdict = "safe"): string {
  const digest = createHash("sha256").update("SKILL.md\0").update(readFileSync(join(dir, "SKILL.md"))).digest("hex");
  const source = createHash("sha256").update("project-local\0").digest("hex").slice(0, 16);
  const path = join(ctx.home, "cache", "project_skill_scans", `${digest}-${source}.json`);
  put(path, JSON.stringify({ bundle_hash: `sha256:${digest}`, scanner_version: ctx.scannerVersion, source: "project-local", source_url: "", verdict }));
  return path;
}

describe("Hermes discovery", () => {
  it("does not discover resources without selected-process identity", () => {
    const cwd = temp();
    skill(join(cwd, ".hermes", "skills"), "unbound");
    expect(hermesCommands(cwd, null).filter(c => c.source !== "builtin")).toEqual([]);
    expect(paneCommands("hermes", cwd, undefined, { hermesContext: null }).filter(c => c.source !== "builtin")).toEqual([]);
  });
  it("offers native result commands only for a resolved process", () => {
    expect(hermesCommands(null, null).some(command => command.name === "status")).toBeFalse();
    const commands = hermesCommands(null, context());
    expect(commands.find(command => command.name === "help")?.source).toBe("builtin");
    expect(commands.find(command => command.name === "status")?.source).toBe("builtin");
    expect(commands.find(command => command.name === "reload-skills")?.source).toBe("builtin");
    expect(commands.some(command => command.name === "diff")).toBeFalse();
  });

  it("requires trust and current native scan proof before project precedence applies", () => {
    const ctx = context(), repo = temp(), external = temp();
    put(join(repo, ".git", "config"), "");
    put(join(ctx.home, "config.yaml"), `skills:\n  trusted_project_dirs: [${repo}]\n  external_dirs: [${external}]\n`);
    skill(join(ctx.home, "skills"), "deploy", "profile");
    skill(external, "deploy", "external");
    const project = skill(join(repo, ".hermes", "skills"), "deploy", "project");
    expect(discoverHermesSkills(repo, ctx).find(c => c.name === "deploy")?.description).toBe("profile");
    approve(project, ctx);
    expect(discoverHermesSkills(repo, ctx).find(c => c.name === "deploy")?.description).toBe("project");
    put(join(project, "script.sh"), "changed bundle bytes");
    expect(discoverHermesSkills(repo, ctx).find(c => c.name === "deploy")?.description).toBe("profile");
  });

  it("rejects dangerous attestations and untrusted project roots", () => {
    const ctx = context(), repo = temp();
    put(join(repo, ".git", "config"), "");
    const dir = skill(join(repo, ".hermes", "skills"), "project");
    approve(dir, ctx);
    expect(discoverHermesSkills(repo, ctx)).toEqual([]);
    put(join(ctx.home, "config.yaml"), `skills:\n  trusted_project_dirs: [${repo}]\n`);
    approve(dir, ctx, "dangerous");
    expect(discoverHermesSkills(repo, ctx)).toEqual([]);
  });

  it("reserves native commands, quick commands and bundles", () => {
    const ctx = context();
    put(join(ctx.home, "config.yaml"), "quick_commands:\n  quick: {type: exec, command: echo test}\n");
    put(join(ctx.home, "skill-bundles", "pack.yaml"), "name: pack\nskills: [helper]\n");
    for (const name of ["status", "reset", "quick", "pack", "diff", "context", "available"]) skill(join(ctx.home, "skills"), name);
    expect(discoverHermesSkills(null, ctx).map(c => c.name)).toEqual(["available"]);
  });

  it("rejects ambiguous modern identifiers but preserves sorted legacy precedence", () => {
    const ctx = context();
    skill(join(ctx.home, "skills", "a"), "duplicate", "first");
    skill(join(ctx.home, "skills", "b"), "duplicate", "second");
    expect(discoverHermesSkills(null, ctx)).toEqual([]);
    expect(discoverHermesSkills(null, { ...ctx, legacy: true }).map(c => c.description)).toEqual(["first"]);
  });

  it("uses selected environment gates and excludes unknown app requirements", () => {
    const ctx = context();
    skill(join(ctx.home, "skills"), "docker", "docker", "environments: [docker]");
    skill(join(ctx.home, "skills"), "unknown", "unknown", "environments: [future-runtime]");
    skill(join(ctx.home, "skills"), "app", "app", "requires_apps: [calendar]");
    expect(discoverHermesSkills(null, ctx).map(c => c.name)).toEqual(["unknown"]);
    expect(discoverHermesSkills(null, { ...ctx, docker: true }).map(c => c.name)).toEqual(["docker", "unknown"]);
  });

  it("expands external roots against selected-process variables and isolates profiles", () => {
    const a = context(), b = context(), external = temp();
    skill(join(a.home, "skills"), "alpha");
    skill(join(b.home, "skills"), "beta");
    skill(external, "external");
    put(join(a.home, "config.yaml"), 'skills:\n  external_dirs: ["${SKILLS_ROOT}"]\n');
    a.env = { SKILLS_ROOT: external };
    expect(discoverHermesSkills(null, a).map(c => c.name)).toEqual(["alpha", "external"]);
    expect(discoverHermesSkills(null, b).map(c => c.name)).toEqual(["beta"]);
  });

  it("prunes support directories and fails closed on malformed profile configuration", () => {
    const ctx = context();
    const parent = skill(join(ctx.home, "skills"), "parent");
    skill(join(parent, "scripts"), "hidden");
    skill(join(ctx.home, "skills", ".archive"), "archived");
    expect(discoverHermesSkills(null, ctx).map(c => c.name)).toEqual(["parent"]);
    put(join(ctx.home, "config.yaml"), "skills: [invalid: {\n");
    expect(discoverHermesSkills(null, ctx)).toEqual([]);
  });

  it("rejects attestations from another scanner or source", () => {
    const ctx = context(), repo = temp();
    put(join(repo, ".git", "config"), "");
    put(join(ctx.home, "config.yaml"), `skills:\n  trusted_project_dirs: [${repo}]\n`);
    const dir = skill(join(repo, ".hermes", "skills"), "project");
    for (const fields of [{ scanner_version: "obsolete" }, { source: "external" }, { source_url: "https://example.invalid" }, { bundle_hash: "sha256:wrong" }]) {
      const path = approve(dir, ctx);
      const attestation = JSON.parse(readFileSync(path, "utf8"));
      put(path, JSON.stringify({ ...attestation, ...fields }));
      expect(discoverHermesSkills(repo, ctx)).toEqual([]);
    }
  });

  it("bounds every directory entry, including non-skill files", () => {
    const ctx = context();
    skill(join(ctx.home, "skills"), "available");
    for (let i = 0; i < 4097; i++) put(join(ctx.home, "skills", `file-${i}`), "");
    expect(discoverHermesSkills(null, ctx)).toEqual([]);
  });

  it("shares a byte budget across profile and external roots", () => {
    const ctx = context(), external = temp();
    put(join(ctx.home, "config.yaml"), `skills:\n  external_dirs: [${external}]\n`);
    const body = "x".repeat(1_048_400);
    for (let i = 0; i < 17; i++) {
      const root = i < 9 ? join(ctx.home, "skills") : external;
      const dir = skill(root, `large-${i}`);
      put(join(dir, "SKILL.md"), `${readFileSync(join(dir, "SKILL.md"), "utf8")}${body}`);
    }
    expect(discoverHermesSkills(null, ctx)).toEqual([]);
  });

  it("rejects oversized and non-regular files before reading their contents", () => {
    const home = temp(), file = join(home, "large");
    put(file, "x".repeat(1025));
    expect(() => readHermesFile(file, 1024)).toThrow();
    expect(() => readHermesFile(home)).toThrow();
  });

  it("honors project discovery being disabled even with trust and current attestation", () => {
    const ctx = context(), repo = temp();
    put(join(repo, ".git", "config"), "");
    put(join(ctx.home, "config.yaml"), `skills:\n  project_discovery: false\n  trusted_project_dirs: [${repo}]\n`);
    const dir = skill(join(repo, ".hermes", "skills"), "project");
    approve(dir, ctx);
    skill(join(ctx.home, "skills"), "local");
    expect(discoverHermesSkills(repo, ctx).map(command => command.name)).toEqual(["local"]);
  });

  it("does not reclassify the profile's own skills as quarantined project resources", () => {
    const repo = temp(), ctx = context(join(repo, ".hermes"));
    put(join(repo, ".git", "config"), "");
    put(join(ctx.home, "config.yaml"), `skills:\n  trusted_project_dirs: [${repo}]\n`);
    skill(join(ctx.home, "skills"), "local");
    expect(discoverHermesSkills(repo, ctx).map(command => command.name)).toEqual(["local"]);
  });

  it("resolves trust paths from the native cwd and does not decode array-shaped scalar paths", () => {
    const ctx = context(), repo = temp();
    ctx.cwd = repo;
    put(join(repo, ".git", "config"), "");
    const dir = skill(join(repo, ".hermes", "skills"), "project");
    approve(dir, ctx);
    put(join(ctx.home, "config.yaml"), 'skills:\n  trusted_project_dirs: ["."]\n');
    expect(discoverHermesSkills(repo, ctx).map(command => command.name)).toEqual(["project"]);
    put(join(ctx.home, "config.yaml"), `skills:\n  trusted_project_dirs: '${JSON.stringify([repo])}'\n`);
    expect(discoverHermesSkills(repo, ctx)).toEqual([]);
  });

  it("reads the legacy active-org marker only from its native mirror directory", () => {
    const ctx = { ...context(), legacy: true }, root = join(ctx.home, "skills");
    skill(join(root, "_org", "active"), "visible");
    skill(join(root, "_org", "foreign"), "hidden");
    put(join(root, ".active_org"), "active");
    expect(discoverHermesSkills(null, ctx)).toEqual([]);
    put(join(root, "_org", ".active_org"), "active");
    expect(discoverHermesSkills(null, ctx).map(command => command.name)).toEqual(["visible"]);
  });

  it("keeps non-string platform and app requirements from failing open", () => {
    const ctx = context(), root = join(ctx.home, "skills");
    skill(root, "numeric-platform", "hidden", "platforms: [42]");
    skill(root, "array-looking-platform", "hidden", 'platforms: "[linux]"');
    skill(root, "numeric-app", "hidden", "requires_apps: [42]");
    skill(root, "mapping-app", "hidden", "requires_apps: {calendar: true}");
    skill(root, "available");
    expect(discoverHermesSkills(null, ctx).map(command => command.name)).toEqual(["available"]);
  });

  it("resolves relative bundle overrides from the selected process cwd", () => {
    const ctx = context();
    ctx.cwd = temp();
    ctx.env = { HERMES_BUNDLES_DIR: "packs" };
    put(join(ctx.cwd, "packs", "pack.yaml"), "name: pack\nskills: [helper]\n");
    put(join(ctx.home, "packs", "wrong.yaml"), "name: available\nskills: [helper]\n");
    skill(join(ctx.home, "skills"), "pack");
    skill(join(ctx.home, "skills"), "available");
    expect(discoverHermesSkills(null, ctx).map(command => command.name)).toEqual(["available"]);
    expect(discoverHermesSkills(null, { ...ctx, cwd: undefined })).toEqual([]);
  });

  it("does not reserve invalid bundles with empty skill entries", () => {
    const ctx = context();
    put(join(ctx.home, "skill-bundles", "pack.yaml"), 'name: pack\nskills: ["", "  "]\n');
    skill(join(ctx.home, "skills"), "pack");
    expect(discoverHermesSkills(null, ctx).map(command => command.name)).toEqual(["pack"]);
  });

  it("reserves aliases declared by the installed native command registry", () => {
    const source = temp(), ctx = context();
    put(join(source, "agent", "skill_commands.py"), "for entry in _skill_catalog():\n    pass\n");
    put(join(source, "tools", "skills_guard.py"), 'SCANNER_VERSION = "current-scanner"\n');
    put(join(source, "hermes_cli", "commands.py"), 'COMMAND_REGISTRY = [\n    CommandDef("prompt", "Compose", "Session", aliases=("compose",)),\n    CommandDef("new", "New", "Session", aliases=("reset",)),\n]\n');
    const features = hermesNativeFeatures(source)!;
    expect(features.legacy).toBeFalse();
    expect(features.scannerVersion).toBe("current-scanner");
    skill(join(ctx.home, "skills"), "compose");
    skill(join(ctx.home, "skills"), "reset");
    skill(join(ctx.home, "skills"), "available");
    expect(discoverHermesSkills(null, { ...ctx, ...features }).map(command => command.name)).toEqual(["available"]);
  });

  it("does not expose a lower-priority skill when an oversized file may own its identifier", () => {
    const ctx = context(), external = temp();
    put(join(ctx.home, "config.yaml"), `skills:\n  external_dirs: [${external}]\n`);
    const dir = skill(join(ctx.home, "skills"), "deploy", "profile");
    put(join(dir, "SKILL.md"), `${readFileSync(join(dir, "SKILL.md"), "utf8")}${"x".repeat(1_048_576)}`);
    skill(external, "deploy", "external");
    expect(discoverHermesSkills(null, ctx)).toEqual([]);
  });

  it("does not expose skills when a bounded bundle read leaves collisions unknown", () => {
    const ctx = context();
    put(join(ctx.home, "skill-bundles", "pack.yaml"), `name: pack\nskills: [helper]\n# ${"x".repeat(1_048_576)}`);
    skill(join(ctx.home, "skills"), "pack");
    expect(discoverHermesSkills(null, ctx)).toEqual([]);
  });
});
