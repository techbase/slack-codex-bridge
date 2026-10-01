# Techbase Bridge

A self-hosted Slack interface to local Codex conversations. Public source under the MIT license.

This project is being built. The first release connects explicit bot mentions in an operator-approved Slack channel to a persistent, read-only Codex conversation about a configured local project. Follow-up mentions in that Slack thread resume the same conversation. Build and release actions stay in the project's existing reviewed workflow.

Each operator creates their own Slack app. This is independent software from Techbase, not an official Slack or OpenAI product. It is not a hosted service or a Slack Marketplace installation.

The scope, user journey, and acceptance criteria are in [the product brief](docs/product-brief.md). Architecture and operating boundaries are in [architecture](docs/architecture.md); the initial alternatives are in [research](docs/research.md).

No Slack workspace is connected yet. Setup instructions will accompany the implementation.
