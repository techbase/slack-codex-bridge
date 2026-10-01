# Techbase Bridge

Implement the accepted scope in docs/product-brief.md and docs/architecture.md.
This is a public MIT-licensed headless service, using the official Slack Bolt and
Codex TypeScript SDK public APIs. It has no Genny-generated source. Do not add an
unused web application, dashboard, hosted account service, or independent Runner
dispatch loop.

Own only this repository. You are not alone in the codebase: preserve others'
changes and accommodate them. Before requiring a dependency change, inspect the
supported APIs/configuration and a correct local solution. If none meets the
requirements, link an owning issue/PR and ask the coordinator for authorization;
do not edit Genny, Runner, Operations, another product, or dependency internals.

Never commit credentials, real workspace/user/channel identifiers, personal notes,
operator configuration, session content, or native Runner state. Use fictional
examples and fixture tests. Do not install a real Slack app, send live messages,
run real model turns, copy an operator's Codex credentials, or deploy a service.

The first release enforces read-only model execution, explicit mentions, configured
team/channel/user access, and safe session/queue recovery. Prompts alone do not
enforce these boundaries. Document actual limits: filesystem read-only is not
repository-only visibility, and model answers can contain project information.

Use minimal standard TypeScript/Node concepts, SQLite only for required durable
state, and node:test. Meaningful tests must cover routing/access, retry/session
recovery, cancellation, Slack output safety, and real SDK invocation configuration
with a fake executable. Run npm ci, typecheck/build, tests, and npm audit. Review
the complete diff. State external integration tests that remain unperformed.

Runner owns execution, review, and evidence. A coordinator publishes the required
Techbase ownership status from Operations. Human merge review remains enabled.
