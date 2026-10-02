# Routing and execution limits

Bridge authorizes workspace, incoming channel and human user before persisting,
replying or launching the CLI. Bot/self/system/edit/shared-channel events are
ignored. Outgoing messages go only to the authorized originating thread or an
operator-configured channel alias, checked in code before every Slack call. Slack
tokens are held by the parent service and omitted from the CLI environment.
A temporary loopback capability lets the MCP sender request only that turn's
allowlisted sends; it is passed through environment, not process arguments.
The capability expires when the invocation closes and carries no Slack token.

These are transport guarantees, **not a new execution sandbox**. Codex inherits
your normal authentication/configuration, apps, MCP tools and consequential
permissions. Bridge supplies no read-only policy, disables no existing tools,
requires no separate account/home, and silently enables no bypass flag. An allowed
Slack user can ask Codex to do anything that runtime permits. Other configured
MCP tools may have their own communication capabilities outside Bridge's sender.
The normal account may read private files or inspect same-account processes;
stripping service tokens from child environment does not make those sources
inaccessible. Choose account/container/mount isolation appropriate to your use.
Even a voluntarily read-only filesystem policy is not repository-only visibility.

Treat the operator config, executable, dependencies, project instructions and
Codex config as trusted. A local process with the same runtime permissions can
read/alter files, inspect environment or interfere with the loopback capability.
Bridge does not defend against it. The sender port binds only loopback and requires
a random per-turn bearer capability; it is not a public HTTP API or OAuth service.
No service token appears in model prompts, MCP configuration arguments or Bridge
logs. Provider/tool/runtime behavior under the operator's own configuration remains
the operator's responsibility.

Output supports Slack mrkdwn and clickable web links. It escapes Slack mention,
channel and other control syntax, preserves only valid HTTP/HTTPS link controls,
disables automatic mentions and link/media unfurls, redacts exact configured
secret values and bounds text. Long explicit links remain literal if they exceed
one chunk. This cannot identify every
unknown, transformed or project-stored secret. Model answers can disclose anything
the runtime knows to everyone who can read the destination channel. Keep channel
audiences and information sensitivity compatible. Prompts are not access controls.

SQLite saves dedup, routing, queued prompts, CLI session IDs and delivery status;
it saves no answers. Terminal prompts are removed. File permissions and local
instance locks protect ordinary service operation, not against administrator or
same-account tampering. See [setup](setup.md) for retention, backups and migration.
Codex/Slack/provider retention is independent; no Codex session file is edited.

Cancellation sends TERM then KILL to the invocation's process group and awaits
child/sender settlement. It cannot roll back work, guarantee termination of a tool
that deliberately detaches itself, or retract an already accepted send. MCP sends
are bounded and stop after uncertain delivery. Neither provider errors nor raw
stderr are printed; logs contain bounded fixed reason codes and generated job IDs.
There are no automatic model retries, send retries or restart replays.

The optional app-server transport relays native approvals and questions without
making authorization decisions. Replies are bound to the active turn, originating
team/channel/thread and requester or configured operator. Prompt IDs expire when
resolved, cancelled, interrupted or restarted; replies are consumed once. Only
explicit human approval grants a native request. Bridge does not persist approval
rules or credentials. Native secret-input prompts fail rather than asking for
secrets in Slack. An uncertain prompt send stops the turn without approving it.
Explicitly disabling the deadline leaves a turn waiting until the user responds,
cancels, or the service stops.

Compatibility evidence is pinned to CLI 0.159.3, including its installed help,
no-model MCP listing, and the public
[JSONL event definitions](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/exec/src/exec_events.rs).
The exec adapter uses the supported event envelope and explicit session IDs. The
app-server adapter follows the pinned CLI's generated v2 stdio protocol and the
official [app-server documentation](https://learn.chatgpt.com/docs/app-server).
It retains normal harness configuration and tools. Recheck
those contracts when updating the pin. The official
[permissions guidance](https://learn.chatgpt.com/docs/agent-approvals-security)
describes Codex controls; Bridge does not attest their host-level enforcement.

Tests cover synthetic routing, durable lifecycle, actual child invocation, real
MCP protocol round trips and output controls with stubbed Slack transport. Live
Slack installation/messages, actual provider authentication/model turns, native
OS sandbox enforcement and Linux/container sandbox behavior remain unperformed.
No production-readiness, confidentiality or model-accuracy certification is made.
