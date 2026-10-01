# Scope decision — 1 October 2026

The accepted product is a small public MIT Slack-to-CLI transport for an existing
Codex runtime. The human clarification superseded the initial read-only project
research pilot and its adoption experiment. See [the current brief](product-brief.md).
Earlier rationale remains in Git history rather than a competing current contract.

Official Bolt Socket Mode supplies incoming transport. The pinned Codex CLI
supplies supported noninteractive JSON/stdin/session interfaces. The official MCP
TypeScript SDK supplies the small stdio sender. The existing SQLite queue/session
store is reused. This needs no hosted platform, custom model SDK wrapper, extra
coordinator or plugin system. Claude/Pi are possible future adapter work only.

Compatibility evidence is version-specific, not a claim that every Codex runtime
or competing bridge was evaluated. See [architecture](architecture.md) and
[security](security.md) for the observed interfaces and unperformed live checks.
