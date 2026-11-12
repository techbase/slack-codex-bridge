
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
