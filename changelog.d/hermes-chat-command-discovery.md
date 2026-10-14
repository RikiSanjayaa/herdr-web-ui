### Added
- Hermes Chat suggests `/retry` and eligible individual skills from the selected native process
  and profile. Project skills require native trust and current scan proof. Ink transcripts can
  resolve a unique process-owned native runtime session.
- Recognized single-skill messages show the user request and a skill chip instead of expanded
  instructions. Native storage and model input stay unchanged; unknown or clipped envelopes
  remain verbatim.
- Hermes `/help`, `/status`, `/reload-skills`, `/version` and `/profile` show native informational
  cards, with key-free dismissal or explicit Ink pager controls. Successful native reloads refresh
  suggestions and transcript skill matching for the selected PC and pane. `/plan`, `/init` and
  `/review` retain native execution and transcript persistence. Recognized approval cards retain
  warnings and require explicit consent. Unknown menus use Terminal; `/diff` and `/context` remain
  outside the Chat command scope.

### Fixed
- Hermes `/profile` cards handle redraws that place the command echo inside or after the result;
  ambiguous earlier results remain in Terminal.
- Plain text inside Markdown emphasis and links avoids unnecessary delimiter-scanner allocations
  without changing parsed content.
- Displaced terminal attachments hold takeover diagnostics until exit can confirm the refusal,
  rather than painting the diagnostic into the pane.
- A terminal released while another app held it restores typing when its fresh attach becomes
  ready, even before the new output stream arrives.
