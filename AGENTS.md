# Techbase Bridge

Implement the accepted Slack-to-CLI transport in docs/product-brief.md and
docs/architecture.md. This public MIT-licensed headless Node/TypeScript service
uses official Slack Bolt Socket Mode, the configured Codex CLI directly, and the
standard MCP TypeScript SDK for its sender. There is no Genny-generated source.
Do not add a dashboard, hosted account service, scheduler or Runner dispatch loop.
Claude/Pi are possible future adapters, not implemented support.

Own only this repository. You are not alone in the codebase: preserve others'
changes. Inspect supported project-local APIs before proposing a dependency fix.
Do not edit Genny, Runner, Operations, another product or dependency internals;
report a true owning-project dependency with its issue/PR to the coordinator.

Never commit credentials, real workspace/user/channel identifiers, operator
configuration, session content or native Runner state. Use fictional examples
and fixtures. Do not install a real Slack app, send live messages, run real model
turns, copy personal credentials, write existing Codex configuration, provision
privileged hosts or deploy during implementation.

The current contract accepts ordinary authorized human messages by default.
Workspace/channel/user routing and outgoing destinations are enforced in code.
Executable, arguments and cwd come only from private operator configuration.
Preserve normal Codex HOME/auth/configuration and operator-selected permissions;
do not impose a separate OS account, isolated home, read-only policy, disabled
MCP/apps/tools or bypass flags. Bridge guarantees routing and invocation, not a
filesystem sandbox or confidentiality of model output. Isolation is a deployment
choice. Never relax Codex policy to make container verification pass.

Use simple TypeScript/Node concepts, the existing SQLite store for durable state,
and node:test. Cover routing/access, bot loops, static CLI/stdin/environment,
real MCP round trips, no-model pinned CLI configuration compatibility,
continuation, bounded admission, deduplication, cancellation, timeouts, shutdown,
restart, uncertain delivery, safe output and doctor. Run npm ci, typecheck/build,
tests and npm audit sequentially. Review the complete diff and public examples.
Report external Slack/model/OS/container checks not performed. An unavailable
Docker engine leaves optional packaging unverified; it must not block native core.

Runner owns execution, review, commits and evidence. A coordinator publishes the
trusted Operations ownership check for the exact reviewed head. Human merge
review remains enabled; do not merge, deploy or mutate native Runner state.
