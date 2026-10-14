import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, opendirSync, readSync, realpathSync, statSync, type Dirent } from "node:fs";
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
  cwd?: string;
  legacy: boolean;
  scannerVersion: string | null;
  coreCommands: ReadonlySet<string>;
  docker: boolean;
  s6: boolean;
}

const MAX_FILE_BYTES = 1_048_576;
const MAX_SCAN_BYTES = 16_777_216;
const MAX_ENTRIES = 4096;
const EXCLUDED: Record<string, true> = { ".git": true, ".github": true, ".hub": true, ".archive": true, ".curator_backups": true, ".locks": true, ".venv": true, venv: true, node_modules: true, "site-packages": true, __pycache__: true, ".tox": true, ".nox": true, ".pytest_cache": true, ".mypy_cache": true, ".ruff_cache": true };
const SUPPORT: Record<string, true> = { references: true, templates: true, assets: true, scripts: true };
const PYTHON_PLATFORM: Record<string, string> = { macos: "darwin", windows: "win32" };
type Mapping = Record<string, unknown>;

/** Treat non-object YAML or JSON values as empty metadata, excluding arrays. */
function mapping(value: unknown): Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Mapping : {};
}

/** Read through one bounded file descriptor, including a check for growth after stat. */
export function readHermesFile(path: string, limit = MAX_FILE_BYTES): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Hermes discovery requires a regular file");
    if (stat.size > limit) throw new RangeError("Hermes discovery file exceeds its bound");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const after = fstatSync(fd);
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new RangeError("Hermes discovery file changed during read");
    }
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}

interface ScanBudget { entries: number; bytes: number }

/** Charge stable file reads to the shared budget; size or mutation errors invalidate the whole scan. */
function readBytes(path: string, limit = MAX_FILE_BYTES, budget?: ScanBudget): Buffer {
  if (budget && budget.bytes > MAX_SCAN_BYTES) throw new Error("Hermes discovery exceeds its byte bound");
  let bytes: Buffer;
  try { bytes = readHermesFile(path, budget ? Math.min(limit, MAX_SCAN_BYTES - budget.bytes) : limit); } catch (error) {
    // Unknown oversized/changing aliases or bundle names could shadow any
    // later suggestion. Do not turn a bounded read into partial discovery.
    if (budget && error instanceof RangeError) budget.bytes = MAX_SCAN_BYTES + 1;
    throw error;
  }
  if (budget && (budget.bytes += bytes.length) > MAX_SCAN_BYTES) throw new Error("Hermes discovery exceeds its byte bound");
  return bytes;
}

/** Collect directory entries within the shared scan cap and close the directory even on failure. */
function entries(path: string, budget: ScanBudget): Dirent[] {
  const directory = opendirSync(path);
  try {
    const result: Dirent[] = [];
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (++budget.entries > MAX_ENTRIES) throw new Error("Hermes discovery exceeds its entry bound");
      result.push(entry);
    }
    return result;
  } finally { directory.closeSync(); }
}

/** Parse a bounded UTF-8 YAML file, tolerating a BOM and treating non-mapping roots as empty. */
function yaml(path: string, budget?: ScanBudget): Mapping {
  return mapping(Bun.YAML.parse(readBytes(path, MAX_FILE_BYTES, budget).toString("utf8").replace(/^\uFEFF/, "")));
}

/** Normalize disable-list values, including YAML array strings, to trimmed nonempty strings. */
function strings(value: unknown): string[] {
  if (typeof value === "string" && value.trimStart().startsWith("[")) {
    try { value = Bun.YAML.parse(value); } catch { return []; }
  }
  return (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
    .filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean);
}

/** Unlike disable lists, native path settings do not decode quoted array strings. */
function configPaths(value: unknown): string[] {
  const paths = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return paths.map(path => String(path).trim()).filter(Boolean);
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

/** Match native command-name normalization, retaining Unicode letters and numbers only in modern Hermes. */
function slug(name: string, legacy: boolean): string {
  const value = name.toLowerCase().replace(/[ _]/g, "-");
  return (legacy ? value.replace(/[^a-z0-9-]/g, "") : value.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

/** Resolve configured paths using the selected process's environment and home; reject unresolved home or base identity. */
function expand(path: string, context: HermesCommandContext, base: string | null = context.home): string {
  let value = path.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (original, braced: string, plain: string) => context.env[braced || plain] ?? original);
  value = value.replace(/^~(?=\/|$)/, context.userHome);
  if (value.startsWith("~") || (!isAbsolute(value) && base === null)) throw new Error("Unresolved native path identity");
  return resolve(isAbsolute(value) ? value : join(base!, value));
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

/** Find the nearest canonical Git root within 64 ancestors, excluding the user's home itself. */
function projectRoot(cwd: string, userHome: string): string | null {
  const canonicalHome = realpathSync(userHome);
  let dir = realpathSync(cwd);
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(join(dir, ".git"))) return dir === canonicalHome ? null : dir;
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
function projectApproved(dir: string, context: HermesCommandContext, budget: ScanBudget, skillBytes: Buffer): boolean {
  if (!context.scannerVersion) return false;
  try {
    const files: { path: string; name: string }[] = [];
    /** Inventory regular files for bundle hashing without following directory symlinks, with a 64-level depth cap. */
    const visit = (path: string, depth: number): void => {
      if (depth > 64) throw new Error("Hermes skill scan exceeds its depth bound");
      for (const entry of entries(path, budget)) {
        const full = join(path, entry.name);
        // pathlib.rglob does not recurse through directory symlinks.
        if (entry.isDirectory()) visit(full, depth + 1);
        else if (statSync(full).isFile()) files.push({ path: full, name: relative(dir, full).split("\\").join("/") });
      }
    };
    visit(dir, 0);
    files.sort((a, b) => compare(a.name, b.name));
    const hash = createHash("sha256");
    for (const file of files) {
      const bytes = readBytes(file.path, MAX_FILE_BYTES, budget);
      if (file.name === "SKILL.md" && !bytes.equals(skillBytes)) return false;
      hash.update(file.name).update("\0").update(bytes);
    }
    const digest = hash.digest("hex");
    const sourceId = createHash("sha256").update("project-local\0").digest("hex").slice(0, 16);
    const attestation = mapping(JSON.parse(readBytes(join(context.home, "cache", "project_skill_scans", `${digest}-${sourceId}.json`), MAX_FILE_BYTES, budget).toString("utf8").replace(/^\uFEFF/, "")));
    return attestation.bundle_hash === `sha256:${digest}` && attestation.scanner_version === context.scannerVersion
      && attestation.source === "project-local" && attestation.source_url === ""
      && (attestation.verdict === "safe" || attestation.verdict === "caution");
  } catch { return false; }
}

/** Apply platform and selected-environment gates; modern app requirements remain hidden without plugin-state proof. */
function visible(metadata: Mapping, context: HermesCommandContext, config: Mapping): boolean {
  const platforms = (Array.isArray(metadata.platforms) ? metadata.platforms : metadata.platforms ? [metadata.platforms] : []).map(value => String(value).trim());
  if (platforms.length && !platforms.some(p => process.platform.startsWith(PYTHON_PLATFORM[p.toLowerCase()] ?? p.toLowerCase()))) return false;
  const environments = (Array.isArray(metadata.environments) ? metadata.environments : metadata.environments ? [metadata.environments] : []).map(value => String(value).trim()).filter(Boolean);
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
  const apps = metadata.requires_apps;
  const requiresApps = Array.isArray(apps) ? apps.length > 0 : apps && (typeof apps !== "object" || Object.keys(apps).length > 0);
  return context.legacy || !requiresApps;
}

/** Bounded, sorted native traversal, preserving aliases while stopping symlink cycles. */
function skillFiles(root: string, legacy: boolean, budget: ScanBudget): string[] {
  const matches: string[] = [];
  let activeOrg: string | null = null;
  if (legacy) {
    try { activeOrg = readBytes(join(root, "_org", ".active_org"), 4096, budget).toString("utf8").trim() || null; } catch { /* no active org */ }
  }
  /** Follow native skill roots with ancestor-only cycle detection, pruning support folders and inactive legacy orgs. */
  const visit = (dir: string, ancestors: Set<string>, depth: number): void => {
    if (depth > 64) throw new Error("Hermes traversal exceeds its depth bound");
    const real = realpathSync(dir);
    if (ancestors.has(real)) return;
    const next = new Set(ancestors).add(real);
    const children = entries(dir, budget);
    const hasSkill = children.some(e => e.name === "SKILL.md" && statSync(join(dir, e.name)).isFile());
    if (hasSkill) matches.push(join(dir, "SKILL.md"));
    for (const entry of children) {
      if (Object.hasOwn(EXCLUDED, entry.name) || (hasSkill && Object.hasOwn(SUPPORT, entry.name))) continue;
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

/** Choose a name's highest-priority alias owner; identical copies in one root need a uniquely shallowest path. */
function uniqueCandidate(index: number, candidates: Candidate[]): boolean {
  const candidate = candidates[index]!;
  const owners = candidates.map((entry, i) => ({ entry, i })).filter(({ entry }) => entry.aliases.includes(candidate.name));
  const tier = Math.min(...owners.map(({ entry }) => entry.root.tier));
  const contenders = owners.filter(({ entry }) => entry.root.tier === tier);
  if (contenders.length === 1) return contenders[0]!.i === index;
  if (!contenders.every(({ entry }) => entry.root.path === contenders[0]!.entry.root.path && entry.bytes.equals(contenders[0]!.entry.bytes))) return false;
  const ranked = contenders.sort((a, b) => relative(a.entry.root.path, a.entry.path).split(/[\\/]/).length - relative(b.entry.root.path, b.entry.path).split(/[\\/]/).length);
  /** Count root-relative path components to reject equal-depth copies rather than picking an arbitrary winner. */
  const depth = ({ entry }: typeof ranked[number]) => relative(entry.root.path, entry.path).split(/[\\/]/).length;
  return depth(ranked[0]!) !== depth(ranked[1]!) && ranked[0]!.i === index;
}

/** Eligible installed individual skills; absence of native proof never enables a project skill. */
export function discoverHermesSkills(cwd: string | null | undefined, context: HermesCommandContext): SlashCommand[] {
  try {
    const budget: ScanBudget = { entries: 0, bytes: 0 };
    const configPath = join(context.home, "config.yaml");
    const config = existsSync(configPath) ? yaml(configPath, budget) : {};
    const skills = mapping(config.skills);
    const disabled = new Set(strings(skills.disabled));
    const platform = context.env.HERMES_PLATFORM || context.env.HERMES_SESSION_PLATFORM;
    for (const name of strings(mapping(skills.platform_disabled)[platform ?? ""])) disabled.add(name);
    disabled.delete("hermes-agent");
    const reserved = new Set([
      ...HERMES_BUILTIN_COMMANDS.map(command => command.name),
      "help", "status", "reload-skills", "version", "profile", "diff", "context", "plan", "review", "init",
      ...context.coreCommands,
      ...Object.keys(mapping(config.quick_commands)),
    ]);
    const override = context.env.HERMES_BUNDLES_DIR?.replace(/^~(?=\/|$)/, context.userHome);
    if (override && ((!isAbsolute(override) && !context.cwd) || override.startsWith("~"))) return [];
    const bundlesDir = override ? resolve(context.cwd ?? context.home, override) : join(context.home, "skill-bundles");
    if (existsSync(bundlesDir)) {
      for (const { name: entry } of entries(bundlesDir, budget).sort((a, b) => compare(a.name, b.name))) {
        if (!/\.ya?ml$/.test(entry)) continue;
        try {
          const bundle = yaml(join(bundlesDir, entry), budget);
          if (!Array.isArray(bundle.skills) || !bundle.skills.some(value => String(value).trim())) continue;
          reserved.add(slug(String(bundle.name || entry.replace(/\.ya?ml$/, "")), context.legacy));
        } catch { /* Native skips invalid bundles too. */ }
      }
    }
    let localSkills = join(context.home, "skills");
    try { localSkills = realpathSync(localSkills); } catch { /* Missing optional local root. */ }
    const roots: Root[] = [];
    /** Register canonical directory roots once, excluding native ignored paths and project aliases of profile skills. */
    const add = (path: string, tier: number) => {
      try {
        const canonical = realpathSync(path);
        if (canonical.split(/[\\/]/).some(part => Object.hasOwn(EXCLUDED, part)) || (tier === 0 && canonical === localSkills)) return;
        if (statSync(canonical).isDirectory() && !roots.some(root => root.path === canonical)) roots.push({ path: canonical, tier });
      } catch { /* Missing optional roots are not resources. */ }
    };
    if (cwd && skills.project_discovery !== false) {
      const project = projectRoot(cwd, context.userHome);
      if (project && configPaths(skills.trusted_project_dirs).some(path => {
        try { return realpathSync(expand(path, context, context.cwd ?? null)) === project; } catch { return false; }
      })) {
        add(join(project, ".hermes", "skills"), 0);
        add(join(project, ".agents", "skills"), 0);
      }
    }
    add(join(context.home, "skills"), 1);
    if (!context.legacy && typeof skills.create_dir === "string") add(expand(skills.create_dir, context), 2);
    for (const path of configPaths(skills.external_dirs)) add(expand(path, context), 3);
    const candidates: Candidate[] = [];
    for (const root of roots) {
      for (const path of skillFiles(root.path, context.legacy, budget)) {
        try {
          const bytes = readBytes(path, MAX_FILE_BYTES, budget);
          if (root.tier === 0 && !projectApproved(dirname(path), context, budget, bytes)) continue;
          if (candidates.length >= MAX_ENTRIES) return [];
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
    if (budget.entries > MAX_ENTRIES || budget.bytes > MAX_SCAN_BYTES) return [];
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
      { name: "plan", description: "Write an implementation plan to .hermes/plans/ without executing tasks", source: "builtin" as const },
      { name: "review", description: "Spawn a background subagent to review recent conversation work", source: "builtin" as const },
      { name: "init", description: "Generate or update AGENTS.md instructions (prompts model, requires write approval)", source: "builtin" as const },
    ] : []),
    ...(context ? discoverHermesSkills(cwd, context) : []),
  ];
}
