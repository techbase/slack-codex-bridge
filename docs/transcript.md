# Example conversation

Fictional transcript. Short request labels below stand in for generated UUIDs.
Every Bridge message is in the originating Slack thread. A follow-up must mention
the bot explicitly; ordinary channel messages are ignored.

```text
Alice:  @Bridge help
Bridge: Mention Bridge with a project question to start or continue this thread.
        Read-only: no implementation, deployment, or external actions.
        Mention Bridge with help, status, or cancel. Only the requester or a
        configured operator may cancel a request.

Alice:  @Bridge Where does this project validate incoming records?
Bridge: Queued request A. I’ll answer here when the read-only turn finishes.
Bridge: Completed request A.
        The request handler calls validateRecord in src/records.ts. I found the
        validation path in source; I haven’t checked a live upstream payload.

Alice:  @Bridge I meant the import path. Please correct that answer.
Bridge: Queued request B. I’ll answer here when the read-only turn finishes.
Bridge: Completed request B.
        The import path validates rows in src/import.ts. My previous answer
        described the HTTP path. The two entry points have different checks.

Alice:  @Bridge Explain the largest files next.
Bridge: Queued request C. I’ll answer here when the read-only turn finishes.
Alice:  @Bridge cancel
Bridge: Cancellation requested for 1 request(s). Active turns must stop before
        the next turn starts.
Bridge: Request C cancelled. No automatic retry.

Alice:  @Bridge Which import checks should we add?
Bridge: Queued request D. I’ll answer here when the read-only turn finishes.
Bridge: Request D failed (model_failed). No completed answer is available.
        An operator can check the safe diagnostic ID; mention Bridge again to retry.
Alice:  @Bridge Which import checks should we add? Please try again.
Bridge: Queued request E. I’ll answer here when the read-only turn finishes.
Bridge: Completed request E.
        Consider checks for duplicate identifiers and empty required fields.
        These are proposals for review; I have not changed the project.
```

After a crash, `@Bridge status` reports an interrupted request and explains that
it is never replayed automatically. If Codex completed but the Slack send failed,
status instead reports `completed` with uncertain outcome delivery. The person
can ask explicitly for another answer; Bridge never silently reruns the turn.
