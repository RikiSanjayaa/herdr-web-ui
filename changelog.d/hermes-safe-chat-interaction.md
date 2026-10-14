### Added
- Hermes Chat answers native tool approvals and confirmations in the classic CLI and default
  TUI. Sends preserve terminal drafts, recheck input before Enter, and stop on changed prompts or
  disconnected senders. Unreadable input and truncated approval previews stay in Terminal.

### Fixed
- Hermes Chat Stop suppresses repeated clicks and composer Escape across a bridge's clients,
  shows Stopping while waiting, and keeps uncertain outcomes consumed without retrying or
  force-exiting. Other agents and direct Terminal input are unchanged.
- Hermes Chat cards recognize the installed TUI's approval footer and single clarification
  questions. Typed answers wait for the native editor before Enter, and classic slash-command
  autocomplete no longer blocks a Chat `/clear` send.
- A terminal released while another app held it restores typing when its fresh attach becomes
  ready, even before the new output stream arrives.
