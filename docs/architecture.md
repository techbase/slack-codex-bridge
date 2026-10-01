# Architecture decisions

## Small local service

Slack Bolt Socket Mode owns event acknowledgement and transport. No incoming
public webhook or hosted OAuth service is needed. Each operator creates their own
app. Socket Mode apps cannot be listed in the Slack Marketplace; public source is
the distribution model here. See [Slack's Socket Mode documentation](https://docs.slack.dev/apis/events-api/using-socket-mode/).

The official Codex TypeScript SDK owns CLI invocation, structured events, and
persistent Codex thread IDs. Use its supported startThread/resumeThread API and
bundled compatible CLI, rather than parsing terminal output or editing Codex
session files. See [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).

This headless Node/TypeScript service is not a generated Go/Vue web application.
Native Runner setup is the supported delivery path. The current Operations
new-project helper creates a private Genny app, so it is not used for this public
tool. Operations registration, native Runner work, independent ownership checks,
and human merge review remain the same. Neither Genny nor Operations needs a
source change for this project.

## Boundaries

Configuration fixes workspace, allowed identities, channel/project mapping,
real paths, and runtime home. Validate nonempty allowlists and fail closed.
Never derive shell commands, executable paths, or cwd from a Slack message.
The initial model turn is read-only, approval policy never, with external
tools/MCP/apps/plugins and web search disabled through supported CLI settings.
Isolate authentication and configuration from the operator's personal Codex home;
never copy authentication automatically. Reject inherited settings that could
expand tool access. Verify actual SDK child environment and arguments in tests.

Read-only sandboxing prevents filesystem mutation under Codex's supported policy;
it does not mean only the selected repository can be read. Run the service as a
dedicated unprivileged account with access only to suitable repositories. Authorized
users and everyone able to read the selected Slack channel may see those projects'
contents in model answers. Slack tokens must not be inherited by the child; secret
redaction of output is additional mitigation, not a confidentiality guarantee.
Slack and the configured model provider receive prompts/results according to
their own policies. Codex model calls require provider connectivity even when
the shell sandbox's network access is disabled.

## Durable state and recovery

Use a private SQLite database for event deduplication, session IDs, bounded queued
requests, delivery state, and status. Prepared statements; schema version checked
on startup; an instance lock prevents competing workers. Basic node:sqlite APIs
on the documented Node minimum are sufficient, avoiding a native database binding.
Store only necessary data. Document that Codex separately persists its conversations.

Serialize work per project. Persist a thread ID as soon as observed. A crashed
active request becomes interrupted, not queued again. Pending Slack delivery must
not rerun Codex. Explain delivery retries/ambiguity honestly: Slack delivery cannot
be guaranteed exactly once across network failure. Distinguish model completion
from final-message delivery. Bound queue, input, output, turn time, retained rows,
and diagnostic output. Abort and await active turns during shutdown before releasing
the instance lock. Avoid bespoke background orchestration beyond this queue.

## Verification

Use injected Slack/model boundaries for deterministic integration tests. Separately
execute the real SDK with a fake CLI to prove options, environment, continuation,
stream/failure handling, and cancellation reach the process. Exercise unauthorized
events, cross-thread isolation, retries, crashes, uncertain Slack delivery, malicious
Slack formatting, long output, missing completion, and clean shutdown. Test the
documented install/build/doctor path on an eligible runtime. Real Slack installation,
real model use, and service deployment remain operator prerequisites.
