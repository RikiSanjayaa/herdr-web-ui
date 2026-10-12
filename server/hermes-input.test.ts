import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesClassicPasteMatches, hermesInputState, hermesSameInput, hermesViewportShowsLive } from "./hermes-input.ts";

const rule = "─".repeat(60);
const classic = (text: string) => `${rule}\n${text}\n${rule}\n`;
const ink = (text: string) => `${text}\n\n─ Idle · smoke-model │ test ─\n`;
const root = mkdtempSync(join(tmpdir(), "herdr-hermes-input-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Hermes terminal input evidence", () => {
  it("requires a visible native composer, not a bare prompt or a clipped box", () => {
    for (const screen of ["", "❯", `${rule}\n`, `lost first row\n${rule}`, "response text"]) {
      expect(hermesInputState(screen)).toBe("unknown");
    }
    expect(hermesInputState(classic("❯"))).toBe("empty");
    expect(hermesInputState(`${rule}\n❯\n`)).toBe("empty");
    expect(hermesInputState(ink("❯"))).toBe("empty");
    expect(hermesInputState("─ Idle · smoke-model │ test ─\n\n❯\n")).toBe("empty");
    expect(hermesInputState(classic("coder ❯"))).toBe("empty");
    expect(hermesInputState(classic("⚕ ❯"))).toBe("empty");
    expect(hermesInputState(classic("⚔"))).toBe("unknown");
  });

  it("reads the default TUI composer beneath its startup branding without losing draft protection", () => {
    const banner = " ⚕ Nous Research · Messenger of the Digital Gods\n\n ╭──────────╮\n │ Hermes Agent │\n ╰──────────╯\n";
    const status = "─ ready │ smoke model │ voice off ─ project";
    expect(hermesInputState(`${banner}${status}\n ❯`)).toBe("empty");
    expect(hermesInputState(`${banner}${status}\n ❯ terminal draft`)).toBe("draft");
    expect(hermesInputState(`${banner}${status}\n ❯ terminal draft\n${status}\n ❯`)).toBe("unknown");
    expect(hermesInputState(classic(`⚕ terminal draft\n${rule}\n❯`))).toBe("unknown");
  });

  it("keeps typed, multiline, shell and folded-paste input", () => {
    for (const text of ["❯ unfinished", "❯ first\nsecond", "$ !echo unfinished", "❯ [Pasted text #1: 5 lines → /tmp/paste]", "❯ [[ log [2 lines] ]]"]) {
      expect(hermesInputState(classic(text))).toBe("draft");
    }
    expect(hermesInputState(classic("❯ next"), null, "next")).toBe("empty");
    expect(hermesInputState(classic("❯ next plus terminal typing"), null, "next")).toBe("draft");
  });

  it("confirms its own complete slash command despite native classic autocomplete", () => {
    const completion = " /clear  Clear screen and start a new session\n";
    const screen = classic("❯ /clear") + completion;
    expect(hermesInputState(screen, null, "/clear")).toBe("empty");
    expect(hermesInputState(screen)).not.toBe("empty");
    expect(hermesInputState(screen, null, "/reset")).not.toBe("empty");
    expect(hermesInputState(classic("❯ /clear terminal draft") + completion, null, "/clear")).not.toBe("empty");
    expect(hermesInputState(screen + "❯ next message\n", null, "/clear")).not.toBe("empty");
    expect(hermesInputState(classic("❯ /clear") + " /reset  Start a new session\n", null, "/clear")).not.toBe("empty");
    expect(hermesInputState(classic(`❯ terminal draft\n${rule}\n❯ /clear`) + completion, null, "/clear")).not.toBe("empty");
  });

  it("does not mistake screenshot-like multiline draft rows for a new empty composer", () => {
    const status = "─ ready │ smoke model │ voice off ─ project";
    for (const screen of [
      classic("❯ unfinished draft\n─────\n❯"),
      classic(`❯ unfinished draft\n${rule}\n❯`),
      classic(`❯ unfinished draft\n${status}\n❯`),
      `${rule}\n❯ unfinished draft\n${rule}\n❯`,
      `${status}\n❯ unfinished draft\n${status}\n❯`,
      ink(`❯ unfinished draft\n${status}\n❯`),
      ink("❯ unfinished draft\n❯"),
      ink(`❯ unfinished draft\n${"continuation\n".repeat(12)}❯`),
      classic(`❯ unfinished draft\n${rule}\n❯ \x1b[3mnot really a placeholder\x1b[0m`),
    ]) {
      expect(hermesInputState(screen)).toBe("unknown");
      expect(hermesInputState(screen, screen)).toBe("unknown");
      expect(hermesInputState(screen, screen, "unfinished draft")).toBe("unknown");
    }
  });

  it("keeps live colors valid across status clock ticks but not scrolls or changed drafts", () => {
    const before = ` ⚕ smoke-model │ ctx -- │ 1s\n${classic("❯ hint")}`;
    const live = ` ⚕ smoke-model │ ctx -- │ 2s\n${classic("❯ hint")}`;
    const colors = ` ⚕ smoke-model │ ctx -- │ 1s\n${classic("❯ \x1b[3mhint\x1b[0m")}`;
    const bottom = { offset_from_bottom: 0 };
    expect(hermesSameInput(before, live)).toBe(true);
    expect(hermesViewportShowsLive(bottom, bottom, colors, before, live)).toBe(true);
    expect(hermesViewportShowsLive({ offset_from_bottom: 1 }, bottom, colors, before, live)).toBe(false);
    expect(hermesViewportShowsLive(bottom, null, colors, before, live)).toBe(false);
    expect(hermesViewportShowsLive(null, null, colors, before, live)).toBe(false);
    expect(hermesViewportShowsLive(bottom, bottom, colors, before, classic("❯ changed"))).toBe(false);
  });

  it("matches its own full text or exact immutable native TUI token, including visual wraps", () => {
    const expected = "a\nb\nc\nd\ne\nf";
    const label = "[[ a b c d e f [6 lines] ]]";
    expect(hermesInputState(ink(`❯ ${label}`))).toBe("draft");
    expect(hermesInputState(ink(`❯ ${label}`), null, expected)).toBe("empty");
    expect(hermesInputState(ink("❯ [[ a b c d\n  e f [6 lines] ]]"), null, expected)).toBe("empty");
    expect(hermesInputState(ink(`❯ ${label} terminal draft`), null, expected)).toBe("draft");
    expect(hermesInputState(ink("❯ [[ z b c d e f [6 lines] ]]"), null, expected)).toBe("draft");
    expect(hermesInputState(ink("❯ [[ a b c d e f [7 lines] ]]"), null, expected)).toBe("draft");
    const large = "A".repeat(2050);
    expect(hermesInputState(ink(`❯ [[ ${"A".repeat(16)}.. [1 lines] .. ${"A".repeat(28)} ]]`), null, large)).toBe("empty");
    expect(hermesInputState(classic("❯ first para\ngraph\nsecond paragraph"), null, "first paragraph\nsecond paragraph")).toBe("empty");
  });

  it("proves a classic folded paste through bounded session-bound content, never token size alone", async () => {
    const home = join(root, "classic"); mkdirSync(join(home, "pastes"), { recursive: true });
    const path = join(home, "pastes", "paste_1_123456.txt");
    const expected = "a\nb\nc\nd\ne\nf";
    const screen = classic(`❯ [Pasted text #1: 6 lines → ${path}]`);
    writeFileSync(path, expected);
    expect(hermesInputState(screen, null, expected)).toBe("draft");
    expect(await hermesClassicPasteMatches(screen, expected, home)).toBe(true);
    expect(await hermesClassicPasteMatches(screen, expected, join(root, "other-home"))).toBe(false);
    expect(await hermesClassicPasteMatches(screen, "x\nb\nc\nd\ne\nf", home)).toBe(false);
    expect(await hermesClassicPasteMatches(screen.replace("6 lines", "7 lines"), expected, home)).toBe(false);
    expect(await hermesClassicPasteMatches(screen.replace("]\n", "] extra draft\n"), expected, home)).toBe(false);
    // Observed kernel mtime lagged a pre-write wall-clock mark by 0.685 ms.
    // Exact intended bytes, not timestamp precision, establish safe delivery.
    utimesSync(path, 1234.000315, 1234.000315);
    expect(await hermesClassicPasteMatches(screen, expected, home)).toBe(true);
    if (process.platform !== "win32") {
      const link = join(home, "pastes", "paste_2_123456.txt"); symlinkSync(path, link);
      expect(await hermesClassicPasteMatches(screen.replace(/#1:|paste_1_/g, (part) => part === "#1:" ? "#2:" : "paste_2_"), expected, home)).toBe(false);
    }
  });



  it("never treats plain placeholder wording or stale colors as an empty input", () => {
    const live = classic("❯ Ask me anything…");
    expect(hermesInputState(live)).toBe("draft");
    expect(hermesInputState(live, classic("❯ \x1b[3mOther hint\x1b[23m"))).toBe("draft");
    expect(hermesInputState(live, live)).toBe("draft");
    expect(hermesInputState(live, classic("❯ \x1b[3mAsk me anything…\x1b[23m"))).toBe("empty");
    expect(hermesInputState(classic("❯ draft"), classic("❯ \x1b[38;2;3;2;7mdraft\x1b[0m"))).toBe("draft");
  });

  it("recognizes Ink's synthetic placeholder cursor, not foreground-colored typed text", () => {
    const live = ink("❯ Ask me anything…");
    const hint = ink("❯ \x1b[48;2;128;128;128m\x1b[38;2;0;0;0mA\x1b[39m\x1b[49m\x1b[38;2;128;128;128msk me anything…\x1b[39m");
    expect(hermesInputState(live, hint)).toBe("empty");
    expect(hermesInputState(live, ink("❯ \x1b[38;2;128;128;128mAsk me anything…\x1b[39m"))).toBe("draft");
    expect(hermesInputState(live, ink("❯ \x1b[48;2;99;99;99m\x1b[38;2;0;0;0mA\x1b[0m\x1b[38;2;128;128;128msk me anything…\x1b[0m"))).toBe("draft");
    // Captured from a clean --tui composer with TERM=xterm-256color and FORCE_COLOR=3.
    const top = " ─ ready │ smoke model │ voice off ─ project\n";
    const text = 'Try "how does the config loader work?"';
    const native = `${top} \x1b[0m\x1b[1m\x1b[38;2;255;248;220m❯ \x1b[0m\x1b[38;2;255;255;255m\x1b[48;2;184;134;11mT\x1b[0m\x1b[38;2;184;134;11m${text.slice(1)}\x1b[0m`;
    expect(hermesInputState(`${top} ❯ ${text}`, native)).toBe("empty");
    expect(hermesInputState(`${top} ❯ ${text}`)).toBe("draft");
  });

  it("refuses special-state prompts even if their input is blank or expected", () => {
    for (const symbol of ["⚠", "🔐", "🔑", "✎", "?", "●", "◉", "🎤"]) {
      expect(hermesInputState(classic(`${symbol} ❯`), null, "")).toBe("blocked");
    }
  });
});
