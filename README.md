# Techbase Bridge

A self-hosted Slack interface to local Codex conversations. Public source under the MIT license.

The first release connects explicit bot mentions in an operator-approved Slack channel to a persistent, read-only Codex conversation about a configured local project. Follow-up mentions in that Slack thread resume the same conversation. Build and release actions stay in the project's existing reviewed workflow.

Each operator creates their own Slack app. This is independent software from Techbase, not an official Slack or OpenAI product. It is not a hosted service or a Slack Marketplace installation.

The scope, user journey, and acceptance criteria are in [the product brief](docs/product-brief.md). Architecture and operating boundaries are in [architecture](docs/architecture.md); the initial alternatives are in [research](docs/research.md).

Use Node **24.16.0 or newer** on macOS or Linux. The minimum is pinned in `.node-version`; install current security patches within your supported Node release. Bolt **5.1.0** and Codex SDK/CLI **0.159.3** are pinned with a lockfile. There is no generated application or web dashboard.

```sh
npm ci
npm run typecheck
npm run build
npm test
npm audit --audit-level=moderate
```

Follow [setup and operating instructions](docs/setup.md) before running `npm run doctor` or `npm start`. Doctor makes no Slack request or model turn, and reports missing credentials without reading a personal Codex home. The [example transcript](docs/transcript.md) shows questions, corrections, cancellation, and recovery.

Read-only execution is **not repository-only read access**. A model answer can disclose project information to everyone who can read the Slack channel. A dedicated unprivileged OS account and an operator review of host policy are prerequisites; see the [execution boundary and verification limits](docs/security.md). Fixture tests do not establish live Slack delivery, model accuracy, or OS sandbox efficacy. No production-readiness claim is made.
