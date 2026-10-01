# Product brief

## Scope

A public MIT self-hosted Slack-to-Codex CLI transport.
The operator already has Codex working and wants authorized Slack messages to
invoke it in a predefined fashion, plus a way for Codex to send messages to
predefined Slack channels. Native machines, servers and suitable container
runtimes are deployment options. A separate macOS account is not a prerequisite.

The operator configures one Slack workspace, incoming channel IDs, allowed human
users, outgoing aliases/IDs, and a static executable/argument list/working directory.
Ordinary new human messages trigger by default, with an optional mention-only mode.
The CLI inherits normal authentication and configuration. Its existing settings
and explicit operator preset own permissions; Bridge adds no execution policy.
Slack text cannot supply process options or arbitrary sender destinations.

Codex gets a standard MCP `send_message` tool for originating-thread replies and
configured aliases. Bridge handles concise queue/error outcomes, per-thread
continuation, bounded admission, event deduplication, serialization, cancellation,
timeouts and shutdown. It never automatically repeats potentially executed work
or resends an uncertain delivery. It uses the existing SQLite durable store.

Setup is install/build, private Slack/routing/preset configuration, doctor, start.
No new OS account, fresh login, mandatory isolated Codex home, installer, dashboard,
hosted OAuth platform, scheduler or project orchestration. Claude/Pi may later use a
similarly cohesive adapter but are not implemented or advertised as supported.

## Completion and evidence

The runnable native core must prove routing and bot-loop exclusion; static CLI
arguments/cwd/stdin and normal environment without Slack tokens; real MCP
client/server sends through a stubbed Slack transport; allowlists and thread
routing; pinned CLI no-model compatibility with existing fixture MCP configuration;
continuation separation, bounded queue/dedup/cancel/timeout/shutdown/restart;
no replay after delivery uncertainty; safe bounded output and malformed/provider
failure handling; and doctor without credentials or a model turn.

Run the repository gates and inspect public examples for private data. Docker is
optional: provide a minimal non-root image/example, explicit mounts and persistent
CLI/state storage. An unavailable engine means packaging is unverified, never a
reason to weaken CLI sandbox policy. Live Slack/model calls and host/container
sandbox enforcement are separate integration checks, not inferred from fixtures.

Bridge has no required project-management or delivery system. The operator chooses
what the CLI does and which development tools it uses; those workflows remain
outside the bridge.
