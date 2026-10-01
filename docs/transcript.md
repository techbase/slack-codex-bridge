# Fictional conversation

Default mode accepts ordinary messages from configured human users. Every Bridge
control/fallback reply stays in the originating thread; Codex may explicitly choose
a configured outgoing alias through its tool. Request labels stand in for UUIDs.

```text
Alice:  help
Bridge: Send a message to start or continue a Codex CLI conversation in this thread
        (mention Bridge if mention-only mode is configured). Codex uses the
        operator’s existing permissions and preset. Use help, status, or cancel.
        Only the requester or a configured operator may cancel a request.

Alice:  Explain how imports are validated in this project.
Bridge: Queued request A. Codex will reply here or use a configured outgoing destination.
Bridge: Completed request A.
        Imports validate required fields in src/import.ts. I inspected the code;
        I have not checked a live upstream payload.

Alice:  Send that summary to the updates channel too.
Bridge: Queued request B. Codex will reply here or use a configured outgoing destination.
        [Codex calls send_message with destination="updates".]
        [The summary appears in the predefined updates channel. No duplicate
         automatic final answer is posted in this thread.]

Alice:  status
Bridge: Request B: completed. Outcome delivered.

Alice:  Check the slow validation path next.
Bridge: Queued request C. Codex will reply here or use a configured outgoing destination.
Alice:  cancel
Bridge: Cancellation requested for 1 request(s). Active turns must stop before
        the next turn starts.
Bridge: Request C cancelled. No automatic retry.
```

A failed/partial send is uncertain: `status` reports it separately from CLI
completion and explains that the turn will not be replayed. After a crash, queued
and active requests become interrupted. Ask again only if you intend a new turn;
Codex actions already performed are not undone. In mention-only mode, prefix each
message/control with `@Bridge`. Bot-generated messages never start another turn.
