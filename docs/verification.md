
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
