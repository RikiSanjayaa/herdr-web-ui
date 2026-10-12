import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverHermesSkills, hermesCommands, type HermesCommandContext } from "./hermes-commands.ts";
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
function approve(dir: string, ctx: HermesCommandContext, verdict = "safe"): void {
  const digest = createHash("sha256").update("SKILL.md\0").update(readFileSync(join(dir, "SKILL.md"))).digest("hex");
  const source = createHash("sha256").update("project-local\0").digest("hex").slice(0, 16);
  put(join(ctx.home, "cache", "project_skill_scans", `${digest}-${source}.json`), JSON.stringify({ bundle_hash: `sha256:${digest}`, scanner_version: ctx.scannerVersion, source: "project-local", source_url: "", verdict }));
}

describe("Hermes discovery", () => {
  it("does not discover resources without selected-process identity", () => {
    const cwd = temp();
    skill(join(cwd, ".hermes", "skills"), "unbound");
    expect(hermesCommands(cwd, null).filter(c => c.source !== "builtin")).toEqual([]);
    expect(paneCommands("hermes", cwd, undefined, { hermesContext: null }).filter(c => c.source !== "builtin")).toEqual([]);
  });
  it("offers native result commands only for a resolved Ink process", () => {
    const ctx = context();
    expect(hermesCommands(null, ctx).some(command => command.name === "status")).toBeFalse();
    const ink = hermesCommands(null, { ...ctx, ink: true });
    expect(ink.find(command => command.name === "help")?.source).toBe("builtin");
    expect(ink.find(command => command.name === "status")?.source).toBe("builtin");
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
    for (const name of ["status", "reset", "quick", "pack", "available"]) skill(join(ctx.home, "skills"), name);
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
});
