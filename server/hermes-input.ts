import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

type InputState = "empty" | "draft" | "unknown" | "blocked";

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const plain = (text: string): string => text.replace(ANSI, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
const solidRule = (line: string): boolean => /^─{3,}$/.test(line.trim());
const statusRule = (line: string): boolean => /^─+\s+\S/.test(line.trim());
// Both renderers prefix named profiles. Unrecognized/custom skin symbols are unknown,
// never evidence of an empty input. `$` is the default TUI's shell-mode prompt.
const prompt = /^(?:[\w.-]+ )?(?:(?:❯|>)|⚕(?:\s+(?:❯|>))?)\s?/u;
const modal = /^(?:⚠|🔐|🔑|✎|\?|●|◉|🎤)(?:\s|$)/u;

/** Parses native composer lines from terminal screen text, returning null if no valid input area is found. */
function inputRows(screen: string, expected?: string): string[] | null {
  const rows = screen.split(/\r?\n/).map((row) => row.trimEnd());
  while (rows.length && !plain(rows.at(-1)!).trim()) rows.pop();
  const lines = rows.map((row) => plain(row).trimEnd());
  const content = (start: number, end = rows.length): string[] | null => {
    while (start < end && !lines[start]!.trim()) start++;
    // A rule/status line pasted INTO a multiline draft is not a new composer.
    // Classic displays at most eight input rows. Ink's bottom-status layout
    // can show more, so inspect all earlier unboxed input prefixes there.
    // A native transcript's boxed prompt is not a second live composer.
    const scanFrom = solidRule(lines[start - 1] ?? "") ? Math.max(0, start - 9) : 0;
    for (let previous = scanFrom; previous < start; previous++) {
      const line = lines[previous]!.trimStart();
      if (/^⚕\s+.*│/.test(line)) continue;
      // Ink's startup branding also begins with ⚕. Only classic's ruled input
      // can use that symbol as a composer prefix.
      if (/^(?:[\w.-]+ )?⚕(?:\s|$)/u.test(line) && !solidRule(lines[previous - 1] ?? "")) continue;
      if ((prompt.test(line) || /^\$\s/.test(line)) && !/[│┃║]$/.test(line)) return null;
    }
    return rows.slice(start, end);
  };
  const last = rows.length - 1;
  let rule = last;
  while (rule >= 0 && !solidRule(lines[rule]!) && !statusRule(lines[rule]!)) rule--;
  if (rule < 0) return null;
  // Classic has solid rules on both sides. Its compact chrome hides the bottom
  // rule. The default Ink TUI has a single labeled status rule above OR below.
  if (rule < last) {
    // Classic puts autocomplete below its bottom rule. Only this send's exact,
    // complete command may ignore that sole matching suggestion during Enter's recheck.
    const completion = expected !== undefined && /^\/[\w:.-]+$/.test(expected) && solidRule(lines[rule]!)
      && last === rule + 1 && lines[last]!.trim().match(/^(\/\S+)\s{2,}\S.*$/)?.[1] === expected;
    if (!completion) return content(rule + 1);
  }
  let top = rule - 1;
  while (top >= 0 && !solidRule(lines[top]!) && !statusRule(lines[top]!)) top--;
  if (solidRule(lines[rule]!) && top >= 0) {
    if (lines[top]!.trim().length !== lines[rule]!.trim().length) return null;
    return content(top + 1, rule);
  }
  // A bottom status rule belongs to Ink. Locate its composer, not an arbitrary
  // older transcript prompt: the composer has at most eight displayed rows here.
  if (statusRule(lines[rule]!)) {
    let start = rule - 1;
    while (start >= Math.max(0, rule - 9)) {
      const row = lines[start]!.trimStart();
      if (prompt.test(row) || modal.test(row) || /^\$\s/.test(row)) return content(start, rule);
      start--;
    }
  }
  return null;
}

/** Compare only native input rows; the status clock may tick between reads. */
export function hermesSameInput(before: string, after: string): boolean {
  const first = inputRows(before);
  const second = inputRows(after);
  return first !== null && second !== null && first.map((row) => plain(row).trimEnd()).join("\n") === second.map((row) => plain(row).trimEnd()).join("\n");
}

/** Confirms that visible viewport ANSI rows match detection text and the terminal is scrolled to the bottom. */
export function hermesViewportShowsLive(scrollBefore: { offset_from_bottom: number } | null, scrollAfter: { offset_from_bottom: number } | null,
  colors: string, before: string, live: string): boolean {
  if (!hermesSameInput(before, live) || !hermesSameInput(colors, live)) return false;
  if (scrollBefore !== null && scrollAfter !== null) return scrollBefore.offset_from_bottom === 0 && scrollAfter.offset_from_bottom === 0;
  // With no scroll metadata, identical composer words do not prove that this
  // isn't an older box. Keep whole-screen evidence for this fallback only.
  const normalized = (text: string): string => plain(text).split(/\r?\n/).map((row) => row.trimEnd()).join("\n").trimEnd();
  return scrollBefore === null && scrollAfter === null && normalized(colors) === normalized(live);
}


/** Checks whether rendered terminal lines represent the expected paste content across soft wraps. */
function renderedPasteMatches(rows: string[], expected: string): boolean {
  let offset = 0;
  const target = expected.trim();
  for (const row of rows) {
    const shown = row.trim();
    if (!target.startsWith(shown, offset)) return false;
    offset += shown.length;
    // Wrapping removes boundary spaces; logical newlines and Ink's continuation
    // gutter are not message content. Never drop whitespace inside a visible row.
    while (offset < target.length && /\s/u.test(target[offset]!)) offset++;
  }
  return offset === target.length;
}

const lineCountFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" });
/** Computes the native Ink TUI token label for folded multiline text pastes. */
function tuiPasteLabel(expected: string): string {
  // Native text.ts edgePreview/pasteTokenLabel: immutable token text is held out
  // of band. Reproduce the displayed identity, not a generic "N lines" token.
  const text = expected.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const flattened = text.replace(/\s+/g, " ").trim().replace(/\]\]/g, "] ]");
  const preview = flattened.length <= 48 ? flattened : `${flattened.slice(0, 16).trimEnd()}.. ${flattened.slice(-28).trimStart()}`;
  const count = lineCountFormat.format(text.split("\n").length).toLowerCase();
  if (!preview) return `[[ [${count} lines] ]]`;
  const [head = preview, tail = ""] = preview.split(".. ", 2);
  return tail ? `[[ ${head.trimEnd()}.. [${count} lines] .. ${tail.trimStart()} ]]` : `[[ ${preview} [${count} lines] ]]`;
}

/** After a known-empty pre-paste check, prove the sole classic token resolves to the intended bytes. */
export async function hermesClassicPasteMatches(live: string, expected: string, home: string): Promise<boolean> {
  const rows = inputRows(live)?.map((row) => plain(row).trimEnd());
  if (!rows?.length) return false;
  const first = rows[0]!.trimStart();
  const prefix = prompt.exec(first);
  if (!prefix) return false;
  const token = [first.slice(prefix[0].length), ...rows.slice(1)].map((row) => row.trim()).join("");
  const match = /^\[Pasted text #(\d+): (\d+) lines → (.+)\]$/u.exec(token);
  if (!match || Number(match[2]) !== expected.replace(/\r\n?/g, "\n").split("\n").length) return false;
  const path = match[3]!;
  if (dirname(path) !== join(resolve(home), "pastes") || !new RegExp(`^paste_${match[1]}_\\d{6}\\.txt$`).test(basename(path))) return false;
  try {
    // No arbitrary path reads: canonical native paste directory, no symlink leaf,
    // regular file and bounded exact content. File timestamps are not ownership:
    // filesystem mtime can precede a Date.now captured immediately before writing.
    if (await realpath(path) !== join(await realpath(dirname(path)), basename(path))) return false;
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      const bytes = Buffer.from(expected.replace(/\r\n?/g, "\n"));
      if (!stat.isFile() || stat.size !== bytes.length) return false;
      const buffer = Buffer.alloc(bytes.length + 1);
      const read = await file.read(buffer, 0, buffer.length, 0);
      return read.bytesRead === bytes.length && buffer.subarray(0, bytes.length).equals(bytes);
    } finally { await file.close(); }
  } catch { return false; }
}


/**
 * Only native composer chrome proves an empty Hermes input. Classic placeholders
 * are italic; Ink uses a foreground-colored hint with a contrasting first-cell
 * synthetic cursor. Colors must already be verified against the live detection
 * read by the caller. Plain hint wording alone is never evidence of emptiness.
 * `expected` permits this delivery's own rendered paste during the Enter recheck.
 */
export function hermesInputState(live: string, colors: string | null = null, expected?: string): InputState {
  const raw = inputRows(live, expected);
  if (!raw?.length) return "unknown";
  const rows = raw.map((row) => plain(row).trimEnd());
  const first = rows[0]!.trimStart();
  if (modal.test(first)) return "blocked";
  const prefix = prompt.exec(first);
  if (!prefix) return /^\$\s/.test(first) ? "draft" : "unknown";
  const text = [first.slice(prefix[0].length), ...rows.slice(1)].join("\n").trim();
  if (!text) return "empty";
  if (expected !== undefined) {
    const body = [first.slice(prefix[0].length), ...rows.slice(1)];
    if (renderedPasteMatches(body, expected.replace(/\r\n?/g, "\n")) || renderedPasteMatches(body, tuiPasteLabel(expected))) return "empty";
  }
  // Folded paste/image tokens represent content, even if a skin colors them like hints.
  if (/\[Pasted text #|\[\[|\[📎|\[Image #/u.test(text)) return "draft";
  if (colors === null) return "draft";
  const shown = inputRows(colors, expected);
  if (!shown || shown.map((row) => plain(row).trimEnd()).join("\n") !== rows.join("\n")) return "draft";
  const body = shown.join("\n");
  let offset = 0;
  let italic = false;
  let fg = "";
  let bg = "";
  let hintFg: string | null = null;
  let chipBg: string | null = null;
  let count = 0;
  let allItalic = true;
  // Skip the visible prompt, including a profile prefix. Interpret extended colors
  // as whole SGR parameters, not as italic/dim switches hidden inside RGB values.
  const prefixLength = rows[0]!.length - first.length + prefix[0].length;
  for (const part of body.split(/(\u001b\[[0-9;]*m)/g)) {
    if (part.startsWith("\u001b[")) {
      const codes = part.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        if (code === 0) { italic = false; fg = ""; bg = ""; }
        else if (code === 3) italic = true;
        else if (code === 23) italic = false;
        else if (code === 39) fg = "";
        else if (code === 49) bg = "";
        else if (code === 38 || code === 48) {
          const size = codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
          if (!size || i + size >= codes.length) return "draft";
          const color = codes.slice(i + 1, i + size + 1).join(";");
          if (code === 38) fg = color; else bg = color;
          i += size;
        } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code);
        else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = String(code - 10);
      }
      continue;
    }
    for (const character of plain(part)) {
      if (offset++ < prefixLength || !character.trim()) continue;
      allItalic &&= italic;
      if (count++ === 0 && bg && fg && bg !== fg) chipBg = bg;
      else {
        if (!fg || bg || (hintFg !== null && hintFg !== fg)) chipBg = null;
        hintFg ??= fg;
      }
    }
  }
  return count > 0 && (allItalic || (count > 1 && chipBg !== null && chipBg === hintFg)) ? "empty" : "draft";
}
