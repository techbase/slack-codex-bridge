# Techbase Bridge

A small, self-hosted Slack-to-Codex CLI bridge. Ordinary human messages in
configured Slack channels run an operator-defined Codex preset. Codex can reply
in the originating thread or use `send_message` to post to predefined channel
aliases. Source is public under the [MIT license](LICENSE).

Bridge uses Slack Bolt Socket Mode, a direct CLI child process and a small MCP
stdio sender. It keeps your normal Codex authentication, configuration and
permissions. It does not create a new account or sandbox, change your Codex
configuration, or silently enable bypass flags. Give Slack access only to people
you trust to use that Codex runtime. Claude CLI and Pi CLI are not supported yet.

## Quick start

Use macOS or Linux with Node **24.16.0+** and a working Codex setup. This release
verifies **Codex CLI 0.159.3**; that CLI is also pinned in the dependencies.

```sh
npm ci
npm run build
```

Create a private state directory (mode `0700`) and copy
[the fictional configuration](examples/bridge.config.json) to a private location
outside Git. Set workspace, incoming channels, permitted users, outgoing aliases,
`codex.executable`, `codex.args` and `codex.cwd`. Set `BRIDGE_CONFIG`,
`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in your private service environment.

```sh
npm run doctor
npm start
```

Doctor checks local prerequisites and CLI/MCP configuration without a Slack send,
a model turn, or requiring new credentials. It does not validate authentication
or prove your CLI permissions work. Follow [setup](docs/setup.md) for the Slack
manifest, native/server operation, migration and the optional Docker example.

## Behavior

- Only configured workspace/channel/human users are admitted. Bot, self, system,
  edit and externally shared-channel events are ignored before storage or replies.
- Ordinary messages trigger by default; `mentionOnly: true` is optional. `help`,
  `status` and `cancel` are local controls (also usable with a bot mention).
- Each Slack thread has its own saved CLI session ID. Requests are bounded,
  deduplicated and serialized through the fixed CLI working directory.
- Messages with attachments also forward their text, including thread replies.
  Queue acknowledgements explain that file contents are not forwarded. An
  attachment-only message gets a reply asking for text and starts no CLI turn.
- Messages cannot select executable, arguments, cwd or arbitrary Slack destinations.
  They remain prompts to Codex, whose permissions are consequential operator settings.
- Codex receives `techbase_bridge.send_message` with a default `thread` destination
  and configured aliases. If any tool send was attempted, Bridge suppresses the
  automatic final answer. Otherwise it posts the final CLI answer in the thread.
- Replies use Slack formatting with bold headings, spacing and clickable web
  links. Mentions and link/media previews stay disabled.
- Uncertain sends are never automatically retried. Restart never replays queued
  or potentially executed work. Use `status` before explicitly asking again.

See [architecture](docs/architecture.md), [security and limits](docs/security.md),
and [a fictional transcript](docs/transcript.md). This is a transport, without a
web UI, hosted account service, scheduler or independent delivery coordinator.

## Development

Run sequentially:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm audit --audit-level=moderate
```

Tests use fictional envelopes, SQLite, a real fake CLI executable, the official
MCP client/server, stubbed Slack APIs and no-model probes of the pinned CLI.
These fixture checks do not verify live Slack delivery, provider authentication,
model behavior or host/container sandbox enforcement. Optional Docker packaging
has **not been built or run**; see [setup](docs/setup.md) for its verification limits.
