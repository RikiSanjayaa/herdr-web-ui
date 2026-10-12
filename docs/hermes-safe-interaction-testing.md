# Manual test: Hermes safe interaction

Use these checks to verify Hermes Chat input safety, native prompt cards and Stop behavior in both the classic CLI and default TUI. Run them in a disposable workspace and a separate herdr session, not a live work session.

## Start a separate local test

Use Bun, Node, herdr and an authenticated Hermes installation. Do not attach the test bridge to a pane your installed web UI already holds.

1. From this checkout, install dependencies and build:

   ```bash
   bun install --frozen-lockfile
   bun run build
   ```

2. In another terminal, start a separate herdr session:

   ```bash
   herdr --session herdr-hermes-manual server
   ```

3. From the checkout, start the local bridge on a separate port and with disposable web UI state:

   ```bash
   export HERDR_SOCKET="${XDG_CONFIG_HOME:-$HOME/.config}/herdr/sessions/herdr-hermes-manual/herdr.sock"
   export HERDR_WEB_STATE_DIR="$(mktemp -d)"
   HOST=127.0.0.1 PORT=7318 bun run server
   ```

4. Open <http://127.0.0.1:7318>. Create a **New workspace** in a disposable directory. In its Terminal lens, start Hermes with `hermes --cli`. Use a new conversation, not an existing work session.

Use `bun run server`, not `bun run start`: this tests the checkout without launching its update supervisor. Your normal Hermes provider configuration still applies, and ordinary messages can incur model charges. A disposable workspace does not isolate Hermes configuration, so avoid choices that permanently change approval settings.

## Check these behaviors

| Check | What to do | Expected result |
| --- | --- | --- |
| Clean send | With an empty Hermes input, send a short message from Chat. | The message reaches Hermes once and the Chat composer clears. |
| Stop | With an empty Chat composer, click Stop while Hermes is responding. After it returns to ready, send another short message. | Chat shows **Stopping…** and disables Stop. The current turn stops, Hermes stays open, and the next message reaches it once. |
| Repeated Stop | During another response, try repeated Stop clicks. Leave an unsent Chat draft and press or hold Escape. | The same observed turn receives at most one Chat interrupt. The draft stays intact; repeated actions do not force-exit Hermes. |
| Stop across clients | Open the same Hermes pane through the same bridge in two tabs or devices. Request Stop from both. Reload one while stopping. | Both see the shared pending or unconfirmed action. The consumed turn cannot receive a second Chat interrupt, including after reload. |
| Unconfirmed Stop | If Hermes does not return to a known ready state after Stop, wait for the confirmation deadline. | After 10 seconds Chat says **Stop not confirmed. Check Terminal.** It does not retry or offer a second click that silently force-exits. |
| Terminal draft | Type `terminal draft - do not send` in Terminal without Enter. In Chat, write a different message and press Send. | Chat refuses the send, keeps its draft, and leaves the terminal draft unchanged. Send or clear the terminal draft yourself before continuing. |
| Multiline paste | Paste the six-line message below into Chat, then click Send once. | Hermes receives one message containing all six lines. Its native paste-collapse display must not cause a refusal or split the message into separate sends. |
| Large paste | Paste a message longer than 2,000 characters, with recognizable text at its beginning, middle and end. Click Send once. | One complete message reaches Hermes, including all three markers. |
| Confirmation | In Chat, type `/clear` and click Send. After its card appears, leave an unsent Chat draft and choose **Cancel** or **No, keep going**, depending on the interface. | The dialog closes without clearing the conversation, and the unsent draft stays intact. `/clear` does not require the Terminal lens. |
| Tool approval | With native manual approvals enabled, create the disposable folder below and ask Hermes to run the specified recursive-delete command. Choose **Deny** in Chat. | The native approval closes as denied, and the marker file remains. Do not select permanent approval or allowlist options. |
| Moved selection | Open another approval. Move its highlight using Terminal's arrow keys, then choose **Deny** in Chat. | Chat answers the option you chose, not whichever option Terminal previously highlighted. |
| Held follow-up | While Hermes is working, send a follow-up from Chat. Before the next turn, leave a draft in its terminal input. | The follow-up becomes held rather than joining or submitting the terminal draft. Clearing the draft or a later working/ready transition must not automatically resend it. An explicit **Send now** delivers it once. |
| Clarification | Ask Hermes a question that needs a choice. Answer its native `clarify` question in Chat, using either a choice or your own text. | Chat shows the question card and Hermes receives the selected or typed answer. This is a separate check from tool approval. |

Six-line message. Paste it; do not type each line with Enter when Enter sends messages:

```text
First line: BEGIN
Second line: alpha
Third line: beta
Fourth line: gamma
Fifth line: delta
Sixth line: END
```

For the approval check, create only disposable data inside the test workspace:

```bash
mkdir -p approval-smoke
printf 'disposable test marker\n' > approval-smoke/marker.txt
```

Ask Hermes: `Use the terminal tool to run rm -rf ./approval-smoke. Do not substitute another command.` Answer **Deny**. Verify the marker using the file viewer or `test -f approval-smoke/marker.txt` in another shell. The test requires Hermes itself to display an approval; an allowlisted command or an approval-disabled profile cannot exercise this case.

Check that the profile uses `approvals.mode: manual`, has no YOLO bypass, and has not allowlisted this command. Use a disposable profile if you need to change those settings. A `clarify` tool call is the agent asking a question, not the security gate approving a terminal command. The tool-approval check counts only when Terminal shows **Dangerous Command** or **approval required**. Asking a model to trigger that gate is not deterministic; it may ask questions or choose another action first. Record that separately rather than treating the wait as approval-card latency.


Repeat the checks in a fresh pane with `hermes --tui`. The classic CLI and default TUI have different input and dialog rendering.

## Safety limits and reporting

- Truncated approval previews, unsupported dialogs, custom input chrome that cannot be recognized, and input whose emptiness cannot be verified stay Terminal-only. A refusal is safer than guessing.
- The Stop guard covers Hermes Chat actions handled by one bridge. Direct Terminal Ctrl+C keeps Hermes's native behavior, including exit on idle input or rapid repeated interrupts. Separate bridge processes do not share Stop claims; a bridge restart resets observations and imposes a startup cooldown.
- Herdr cannot atomically compare Hermes's native running state and apply an interrupt. A finish between the final fresh check and the key remains possible; the guard suppresses repeated Chat requests rather than changing Hermes itself.
- If delivery is uncertain, inspect Terminal before sending again. Do not assume nothing was typed and do not click Send repeatedly.
- Precise prompt-change-before-Enter and disconnect-after-paste races are covered by automated regression tests; they are difficult to trigger reliably by hand.
- Record the interface (`--cli` or `--tui`), Hermes version, test row, expected versus actual result, and a screenshot of Chat and Terminal. Redact credentials and private content.
- Record skipped checks as **not run**, not passed.

## Stop

Stop the local bridge with Ctrl+C in its server terminal. Close the test session with:

```bash
herdr --session herdr-hermes-manual server stop
```

Keep your normal herdr session running. Remove the disposable workspace and web UI state only after checking their paths and saving any evidence you want to discuss.
