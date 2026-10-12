import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SlashCommand } from "../shared/protocol.ts";

/** Native /retry creates another persisted assistant turn; informational commands do not. */
export const HERMES_BUILTIN_COMMANDS = [
  { name: "retry", description: "Retry the last message (requires a previous message)" },
] as const;

/** Installed native semantics and selected-process facts, never the bridge's environment. */
export interface HermesCommandContext {
  home: string;
  userHome: string;
  env: Readonly<Record<string, string>>;
  legacy: boolean;
  scannerVersion: string | null;
  coreCommands: ReadonlySet<string>;
  docker: boolean;
  s6: boolean;
}

const MAX_FILE_BYTES = 1_048_576;
const MAX_SCAN_BYTES = 16_777_216;
const MAX_ENTRIES = 4096;
const EXCLUDED = new Set([".git", ".github", ".hub", ".archive", ".curator_backups", ".locks", ".venv", "venv", "node_modules", "site-packages", "__pycache__", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
const SUPPORT = new Set(["references", "templates", "assets", "scripts"]);
const PYTHON_PLATFORM: Record<string, string> = { macos: "darwin", mac: "darwin", windows: "win32" };
type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Mapping : {};
}

/** Read through one bounded file descriptor, including a check for growth after stat. */
function readBytes(path: string, limit = MAX_FILE_BYTES): Buffer {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Hermes discovery file exceeds its bound");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > stat.size) throw new Error("Hermes discovery file changed during read");
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}

function yaml(path: string): Mapping {
  return mapping(Bun.YAML.parse(readBytes(path).toString("utf8").replace(/^\uFEFF/, "")));
}

function strings(value: unknown): string[] {
  if (typeof value === "string" && value.trimStart().startsWith("[")) {
    try { value = Bun.YAML.parse(value); } catch { return []; }
  }
  return (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
    .filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean);
}

/** Python's Unicode string order, without locale-dependent collation. */
function compare(a: string, b: string): number {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!, y = b.codePointAt(j)!;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return (a.length - i) - (b.length - j);
}

function slug(name: string, legacy: boolean): string {
  const value = name.toLowerCase().replace(/[ _]/g, "-");
  return (legacy ? value.replace(/[^a-z0-9-]/g, "") : value.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

function expand(path: string, context: HermesCommandContext): string {
  let value = path.replace(/^~(?=\/|$)/, context.userHome);
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (original, braced: string, plain: string) => context.env[braced || plain] ?? original);
  return resolve(isAbsolute(value) ? value : join(context.home, value));
}

/** Extract only declarations; never import or execute an installed Python module. */
export function hermesNativeFeatures(source: string): Pick<HermesCommandContext, "legacy" | "scannerVersion" | "coreCommands"> | null {
  try {
    const scanner = readBytes(join(source, "agent", "skill_commands.py")).toString("utf8");
    const legacy = !/\b_skill_catalog\s*\(/.test(scanner);
    if (legacy && !scanner.includes("get_project_skills_dirs")) return null;
    const guard = readBytes(join(source, "tools", "skills_guard.py")).toString("utf8");
    const scannerVersion = guard.match(/^SCANNER_VERSION\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
    const registry = readBytes(join(source, "hermes_cli", "commands.py")).toString("utf8");
    const coreCommands = new Set<string>();
    const definitions = [...registry.matchAll(/CommandDef\(\s*["']([^"']+)["']/g)];
    for (let i = 0; i < definitions.length; i++) {
      const match = definitions[i]!;
      coreCommands.add(match[1]!.toLowerCase());
      const definition = registry.slice(match.index, definitions[i + 1]?.index ?? registry.length);
      const aliases = definition.match(/\baliases\s*=\s*\(([^)]*)\)/)?.[1];
      if (aliases) for (const alias of aliases.matchAll(/["']([^"']+)["']/g)) coreCommands.add(alias[1]!.toLowerCase());
    }
    return coreCommands.size ? { legacy, scannerVersion, coreCommands } : null;
  } catch { return null; }
}

function projectRoot(cwd: string, userHome: string): string | null {
  let dir = realpathSync(cwd);
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(join(dir, ".git"))) return dir === userHome ? null : dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

interface Root { path: string; tier: number }
interface Candidate {
  path: string;
  root: Root;
  name: string;
  aliases: string[];
  bytes: Buffer;
  metadata: Mapping;
  description: string;
  eligible: boolean;
}

/** Native project scans attest all file names and bytes, not just SKILL.md. */
function projectApproved(dir: string, context: HermesCommandContext): boolean {
  if (!context.scannerVersion) return false;
  try {
    const files: { path: string; name: string }[] = [];
    let entries = 0;
    const visit = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (++entries > MAX_ENTRIES) throw new Error("Hermes skill scan exceeds its bound");
        const full = join(path, entry.name);
        // pathlib.rglob does not recurse through directory symlinks.
        if (entry.isDirectory()) visit(full);
        else if (statSync(full).isFile()) files.push({ path: full, name: relative(dir, full).split("\\").join("/") });
      }
    };
    visit(dir);
    files.sort((a, b) => compare(a.name, b.name));
    const hash = createHash("sha256");
    let total = 0;
    for (const file of files) {
      const bytes = readBytes(file.path);
      if ((total += bytes.length) > MAX_SCAN_BYTES) return false;
      hash.update(file.name).update("\0").update(bytes);
    }
    const digest = hash.digest("hex");
    const sourceId = createHash("sha256").update("project-local\0").digest("hex").slice(0, 16);
    const attestation = mapping(JSON.parse(readBytes(join(context.home, "cache", "project_skill_scans", `${digest}-${sourceId}.json`)).toString("utf8").replace(/^\uFEFF/, "")));
    return attestation.bundle_hash === `sha256:${digest}` && attestation.scanner_version === context.scannerVersion
      && attestation.source === "project-local" && attestation.source_url === ""
      && (attestation.verdict === "safe" || attestation.verdict === "caution");
  } catch { return false; }
}

function visible(metadata: Mapping, context: HermesCommandContext, config: Mapping): boolean {
  const platforms = strings(metadata.platforms);
  if (platforms.length && !platforms.some(p => process.platform.startsWith(PYTHON_PLATFORM[p.toLowerCase()] ?? p.toLowerCase()))) return false;
  const environments = strings(metadata.environments);
  if (environments.length && !environments.some(tag => {
    switch (tag.toLowerCase()) {
      case "docker": return context.docker;
      case "s6": return context.s6;
      case "kanban": return Boolean(context.env.HERMES_KANBAN_TASK || context.env.HERMES_KANBAN_BOARD)
        || strings(config.toolsets).includes("kanban") || Object.values(mapping(config.platform_toolsets)).some(v => strings(v).includes("kanban"));
      default: return true;
    }
  })) return false;
  // App declarations are in-memory plugin state. Unknown availability fails closed,
  // as native skill_matches_apps does; the legacy runtime has no such gate.
  return context.legacy || strings(metadata.requires_apps).length === 0;
}

/** Bounded, sorted native traversal, preserving aliases while stopping symlink cycles. */
function skillFiles(root: string, legacy: boolean): string[] {
  const matches: string[] = [];
  let count = 0;
  let activeOrg: string | null = null;
  if (legacy) {
    try { activeOrg = readBytes(join(root, ".active_org"), 4096).toString("utf8").trim() || null; } catch { /* no active org */ }
  }
  const visit = (dir: string, ancestors: Set<string>, depth: number): void => {
    if (++count > MAX_ENTRIES || depth > 64) throw new Error("Hermes traversal exceeds its bound");
    const real = realpathSync(dir);
    if (ancestors.has(real)) return;
    const next = new Set(ancestors).add(real);
    const entries = readdirSync(dir, { withFileTypes: true });
    const hasSkill = entries.some(e => e.name === "SKILL.md" && statSync(join(dir, e.name)).isFile());
    if (hasSkill) matches.push(join(dir, "SKILL.md"));
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name) || (hasSkill && SUPPORT.has(entry.name))) continue;
      if (legacy && dir === root && entry.name === "_org" && !activeOrg) continue;
      if (legacy && dir === join(root, "_org") && entry.name !== activeOrg) continue;
      const path = join(dir, entry.name);
      try { if (statSync(path).isDirectory()) visit(path, next, depth + 1); } catch (error) {
        if (entry.isDirectory()) throw error;
        // A broken symlink is not a native skill directory.
      }
    }
  };
  visit(root, new Set(), 0);
  return matches.sort(compare);
}

function uniqueCandidate(index: number, candidates: Candidate[]): boolean {
  const candidate = candidates[index]!;
  const owners = candidates.map((entry, i) => ({ entry, i })).filter(({ entry }) => entry.aliases.includes(candidate.name));
  const tier = Math.min(...owners.map(({ entry }) => entry.root.tier));
  const contenders = owners.filter(({ entry }) => entry.root.tier === tier);
  if (contenders.length === 1) return contenders[0]!.i === index;
  if (!contenders.every(({ entry }) => entry.root.path === contenders[0]!.entry.root.path && entry.bytes.equals(contenders[0]!.entry.bytes))) return false;
  const ranked = contenders.sort((a, b) => relative(a.entry.root.path, a.entry.path).split(/[\\/]/).length - relative(b.entry.root.path, b.entry.path).split(/[\\/]/).length);
  const depth = ({ entry }: typeof ranked[number]) => relative(entry.root.path, entry.path).split(/[\\/]/).length;
  return depth(ranked[0]!) !== depth(ranked[1]!) && ranked[0]!.i === index;
}

/** Eligible installed individual skills; absence of native proof never enables a project skill. */
export function discoverHermesSkills(cwd: string | null | undefined, context: HermesCommandContext): SlashCommand[] {
  try {
    const configPath = join(context.home, "config.yaml");
    const config = existsSync(configPath) ? yaml(configPath) : {};
    const skills = mapping(config.skills);
    const disabled = new Set(strings(skills.disabled));
    const platform = context.env.HERMES_PLATFORM || context.env.HERMES_SESSION_PLATFORM;
    for (const name of strings(mapping(skills.platform_disabled)[platform ?? ""])) disabled.add(name);
    disabled.delete("hermes-agent");
    const reserved = new Set([
      ...HERMES_BUILTIN_COMMANDS.map(command => command.name),
      "help", "status", "reload-skills", "version", "profile", "diff", "plan", "review", "init",
      ...context.coreCommands,
      ...Object.keys(mapping(config.quick_commands)),
    ]);
    const bundlesDir = context.env.HERMES_BUNDLES_DIR ? expand(context.env.HERMES_BUNDLES_DIR, context) : join(context.home, "skill-bundles");
    if (existsSync(bundlesDir)) {
      for (const entry of readdirSync(bundlesDir).sort(compare)) {
        if (!/\.ya?ml$/.test(entry)) continue;
        try {
          const bundle = yaml(join(bundlesDir, entry));
          if (!Array.isArray(bundle.skills) || !bundle.skills.length) continue;
          reserved.add(slug(String(bundle.name || entry.replace(/\.ya?ml$/, "")), context.legacy));
        } catch { /* Native skips invalid bundles too. */ }
      }
    }
    const roots: Root[] = [];
    const add = (path: string, tier: number) => {
      try {
        const canonical = realpathSync(path);
        if (statSync(canonical).isDirectory() && !roots.some(root => root.path === canonical)) roots.push({ path: canonical, tier });
      } catch { /* Missing optional roots are not resources. */ }
    };
    if (cwd) {
      const project = projectRoot(cwd, context.userHome);
      if (project && strings(skills.trusted_project_dirs).some(path => {
        try { return realpathSync(expand(path, context)) === project; } catch { return false; }
      })) {
        add(join(project, ".hermes", "skills"), 0);
        add(join(project, ".agents", "skills"), 0);
      }
    }
    add(join(context.home, "skills"), 1);
    if (!context.legacy && typeof skills.create_dir === "string") add(expand(skills.create_dir, context), 2);
    for (const path of strings(skills.external_dirs)) add(expand(path, context), 3);
    const candidates: Candidate[] = [];
    let total = 0;
    for (const root of roots) {
      for (const path of skillFiles(root.path, context.legacy)) {
        if (root.tier === 0 && !projectApproved(dirname(path), context)) continue;
        try {
          const bytes = readBytes(path);
          if ((total += bytes.length) > MAX_SCAN_BYTES || candidates.length >= MAX_ENTRIES) return [];
          const content = bytes.toString("utf8").replace(/^\uFEFF/, "");
          const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
          const metadata = match ? mapping(Bun.YAML.parse(match[1]!)) : {};
          const name = String(metadata.name ?? basename(dirname(path)));
          const body = match ? content.slice(match[0].length) : content;
          const description = typeof metadata.description === "string" ? metadata.description
            : body.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith("#")) ?? `Invoke the ${name} skill`;
          const aliases = [...new Set([name, basename(dirname(path)), relative(root.path, dirname(path)).split("\\").join("/")])];
          candidates.push({ path, root, bytes, metadata, name, aliases, description,
            eligible: (metadata.name === undefined || typeof metadata.name === "string") && visible(metadata, context, config) && !disabled.has(name) });
        } catch { /* Native skips unreadable or malformed individual skill metadata. */ }
      }
    }
    const names = new Set<string>(), slugs = new Set<string>();
    const result: SlashCommand[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      if (!candidate.eligible || (context.legacy ? names.has(candidate.name) : !uniqueCandidate(i, candidates))) continue;
      names.add(candidate.name);
      const command = slug(candidate.name, context.legacy);
      if (!command || reserved.has(command) || slugs.has(command)) continue;
      slugs.add(command);
      result.push({ name: command, description: candidate.description.trim().slice(0, 120), source: "skill" });
    }
    return result.sort((a, b) => compare(a.name, b.name));
  } catch { return []; }
}

/** Existing wire interface; unresolved identity yields no profile resources. */
export function hermesCommands(cwd?: string | null, context?: HermesCommandContext | null): SlashCommand[] {
  return [
    ...HERMES_BUILTIN_COMMANDS.map(command => ({ ...command, source: "builtin" as const })),
    ...(context ? [
      { name: "help", description: "Show native help (visible terminal portion)", source: "builtin" as const },
      { name: "status", description: "Show native session status (terminal-backed card)", source: "builtin" as const },
      { name: "reload-skills", description: "Reload native skills and refresh Chat suggestions", source: "builtin" as const },
      { name: "version", description: "Show native version and installation diagnostics", source: "builtin" as const },
      { name: "profile", description: "Show active profile name and home directory", source: "builtin" as const },
      { name: "diff", description: "Show git working changes or session diff", source: "builtin" as const },
      { name: "plan", description: "Write an implementation plan to .hermes/plans/ without executing tasks", source: "builtin" as const },
      { name: "review", description: "Spawn a background subagent to review recent conversation work", source: "builtin" as const },
      { name: "init", description: "Generate or update AGENTS.md instructions (prompts model, requires write approval)", source: "builtin" as const },
    ] : []),
    ...(context ? discoverHermesSkills(cwd, context) : []),
  ];
}
