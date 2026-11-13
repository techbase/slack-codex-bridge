
## Own-bot parent reply context

Replies to an own-bot root posted outside a saved session now carry bounded
parent text separately from the authenticated human request. The accepted reply
timestamp survives the queue and schema-1 migration. Later root edits, missing
reads, truncated text and attachment omissions remain explicit. Parent data does
not grant native permissions or reapply a consumed approval.

Native macOS qualification passed npm ci, typecheck/build and all 66 tests.
Tests include root-scope and author checks, source secret redaction, cancellation
during a pending read, continued sessions, both Codex transports, schema migration
and unchanged native approval handling. The required audit initially identified
seven existing advisories; compatible MCP SDK/Zod and locked transitive updates
restored a zero-advisory audit. The Codex executable pin and operator permissions
were preserved.

The actual Slack SDK read the exact operator-authorized bot parent successfully.
A separate native app-server qualification received only “Approved” plus a
non-executing fictional parent proposal and identified the correct proposal.
It requested no additional approval and performed no real project action. Its
reply was captured rather than sent to Slack, and its owned chat was archived.
Production Socket Mode reply delivery after rollout is a distinct check.

## Conversation during a pending approval

Native macOS qualification passes npm ci, typecheck/build, all 78 tests and a
zero-vulnerability dependency audit. Regression cases use native protocol
fixtures for command/file/permission/URL approvals, same-session continuation,
withdrawn prompt IDs, duplicate events, requester/operator boundaries, multiple
approvals, input/form validation and failure before follow-up admission. Prior
process exit remains required before the next model turn starts. No live Slack
message, real approval or owning-project action is part of these tests.

## Authenticated human extension

Native staged npm ci, typecheck/build and all 103 tests pass, including callback
receipts, conditional model bypass, admission/FIFO, cancellation/process cleanup,
Unicode pipe boundaries, invalid/oversized output, redaction, event deduplication
and uncertain acknowledgement behavior. Dependency audit reports zero
vulnerabilities. Existing native approval controls remain unchanged. These
checks use local fixtures and no live Slack message or product action.

## Concurrent request lifecycle and routing

Independent conversation lanes now run concurrently within a configured bound,
while shared native chat IDs and per-lane attachment notices preserve ordering.
Accepted queued work survives its former expiry and acknowledged unstarted work
survives restart; active/uncertain-notice work is never replayed. Dedup identity
stays protected for unfinished jobs beyond normal retention age.

The additive schema-3 snapshot exposes retained bounded request/outcome context,
exact native identities and explicit outcome delivery separately from progress.
The operator CLI reads existing schemas 1–3 without instance locking, recovery,
Slack authentication or model execution. A read against an existing running
schema-2 instance succeeded; historical unknown final proof and missing reply
timestamps remained unknown/missing.

Native macOS qualification passed npm ci, typecheck/build, all 136 tests and
npm audit with zero advisories in an isolated staging directory. Added coverage
includes bounded concurrent lanes, shared-chat FIFO, scoped cancellation, queue
survival, restart/dedup, read-only snapshot paging/legacy data and separate final
delivery proof. Missing native completion notifications are reconciled only from
the invocation's own connection and exact owned turn; foreign, active, notLoaded
and unavailable observations do not establish completion or authorize replay.

The generic operator report_state hook and explicit send_message outcome kind
were exercised through real fixture processes/MCP clients. Lifecycle metadata
does not authorize product work or native approvals. Qualification sent no extra
live Slack messages or product actions. Live provider behavior, production
completion-watch delivery and optional Docker packaging remain separate checks.

## Larger configured concurrency — 13 November 2026

The supported concurrency range is now 1–64; the conservative public default remains four. An isolated scheduler regression held 25 independent requests active, retained request 26 in the queue, and started it when capacity became available. Same-native-chat serialization remains covered by the existing suite. No 25-model production load test or live Slack test was performed.

Clean npm ci, typecheck/build, all 137 tests and the required moderate-level audit passed. Two newly reported transitive advisories required compatible lockfile patch updates: @hono/node-server 2.1.3→2.1.8 and hono 4.13.12→4.13.18. Audit now reports zero advisories.
