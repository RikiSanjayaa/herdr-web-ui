# Chat transcripts

Language for turning an agent's native conversation history into the chat lens without making the bridge the owner of that history.

## Language

**Hermes transcript store**:
The `state.db` owned by the Hermes process running in a pane. A bridge-wide Hermes database is not necessarily that pane's store.
_Avoid_: Global Hermes database, bridge Hermes store

**Exchange**:
A user message and the agent activity that follows it up to the next user message. An exchange may be larger than one transcript page.
_Avoid_: Page, request

**Transcript page**:
A bounded, contiguous segment of conversation history returned by one read. A page may split an exchange.
_Avoid_: Exchange, whole turn

**Transcript generation**:
One stable lineage of a transcript store, used to distinguish its cursors and opaque content references from those of a replaced store or another session.
_Avoid_: Cache version, session ID
