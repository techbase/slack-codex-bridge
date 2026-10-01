# Techbase Bridge

Implement the Slack-to-CLI transport described in docs/product-brief.md and
docs/architecture.md. This public MIT-licensed headless Node/TypeScript service
uses official Slack Bolt Socket Mode, the configured Codex CLI directly, and the
standard MCP TypeScript SDK for its sender. Keep it a standalone bridge; do not
add a dashboard, hosted account service, scheduler or project orchestration.
Claude/Pi are possible future adapters, not implemented support.

Own only this repository. You are not alone in the codebase: preserve others'
changes. Inspect supported project-local APIs before proposing a dependency fix.
Do not edit another project or dependency internals. If a dependency change is
necessary, report it through the owning project's issue/PR process.

Never commit credentials, real workspace/user/channel identifiers, operator
configuration, session content or local automation metadata. Use fictional
examples and fixtures for verification. Live Slack/model interactions, changes
to operator configuration and deployment must be within the user's authorized
task. Do not copy personal credentials or provision privileged hosts.

Ordinary authorized human messages trigger the configured CLI by default.
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
tests and npm audit for affected software changes. For documentation-only changes,
check the complete diff, links and consistency without repeating unchanged tests.
Report external Slack/model/OS/container checks not performed. An unavailable
Docker engine leaves optional packaging unverified; it must not block native core.

Use normal repository commits and pull requests. Follow required GitHub checks
and the user's integration/deployment authorization. Development tools chosen by
a contributor are not installation or runtime requirements for Bridge.
