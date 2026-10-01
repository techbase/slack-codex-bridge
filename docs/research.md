# Initial alternatives — observed 1 October 2026

This is a small delivery comparison based on primary documentation and source
READMEs. No competing product was installed or usability-tested. It supports an
interim tool decision, not a market-size or commercial viability claim.

| Alternative | Documented approach | Relevance |
| --- | --- | --- |
| [Official ChatGPT Slack integration](https://developers.openai.com/codex/integrations/slack/) | Slack requests delegate to cloud tasks in supported workspaces. | Useful adjacent product; the accepted requirement here is local Mega Mini projects and their existing delivery process. |
| [earonesty/codex-slack](https://github.com/earonesty/codex-slack) | MIT self-hosted TypeScript/Bolt/SQLite bridge using Codex app-server; thread sessions, approvals, stop/status, dedicated-channel messages. | Strong existing alternative. Broader interactive execution scope than this initial explicit-mention, read-only pilot. |
| [usuginus/slack-codex-bridge](https://github.com/usuginus/slack-codex-bridge) | MIT bridge for mentions/slash commands with optional channel context and Codex CLI replies. | Establishes that a Slack-to-Codex bridge is an existing category, not a novel invention. Live behavior remains unverified. |
| Direct Codex + GitHub/Runner | Existing project conversations and reviewed implementation. | Baseline for the pilot; it already works, so reduced communication friction must be demonstrated. |

## Decision and limits

Pursue the authorized small self-hosted public tool. Keep conversation transport
separate from approved implementation/release. The initial distinction is narrow,
inspectable access/session/recovery behavior and compatibility with Techbase's
existing native Runner workflow. These are design goals to verify, not a proven
competitive advantage.

No credible durable moat is identified. Workflow integration may become useful
if users retain accepted project context and use it repeatedly, but no customer
demand, willingness to pay, distribution advantage, or switching-cost evidence has
been established. A three-task pilot in the product brief is the next validation.
Avoid a hosted platform or commercial claims until that evidence exists.

Primary technical references: [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), and
[Node SQLite](https://nodejs.org/api/sqlite.html). The latter remains an evolving
Node API; pin a supported minimum and use only APIs verified on that runtime.
