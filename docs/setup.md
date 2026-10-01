# Setup and operation

Bridge is a headless service for a single operator-configured Slack workspace.
All IDs and paths below are fictional. Do not put operator configuration, tokens,
database files, Codex sessions, or personal notes in this public repository.

## 1. Prepare the account and runtime

Use a dedicated **unprivileged** macOS or Linux account. Give it read access only
to projects and other files suitable for the channel's audience. Use a local
filesystem for state; network filesystems and multiple hosts sharing the database
are unsupported. Install Node 24.16.0 or newer, then run `npm ci` and
`npm run build` in the checkout. Do not omit optional dependencies: the official
SDK needs its matching platform CLI. No global Codex installation is used.

The code uses basic `DatabaseSync`/prepared statements from `node:sqlite` and
`node:test`, available without a SQLite flag on this minimum. SQLite can still
produce an experimental warning on Node 24. The locked runtime dependency
engines are compatible with the minimum. CI exercises `.node-version`.

Create separate private directories outside every mapped project, owned by the
service account. Use canonical paths (on macOS `/var` often resolves to
`/private/var`) without symlink components. For example, after the administrator
has provisioned `/srv/bridge` for that account:

```sh
umask 077
mkdir -m 700 /srv/bridge/state /srv/bridge/codex
cp examples/bridge.config.json /srv/bridge/bridge.config.json
cp .env.example /srv/bridge/bridge.env
chmod 600 /srv/bridge/bridge.config.json /srv/bridge/bridge.env
```

Edit the private JSON with your workspace ID, bot user ID, allowed human IDs,
channel IDs, and absolute Git project roots. Operators must also be in
`allowedUserIds`. A root with a `.git` worktree file is supported. Channel aliases
resolve to one real path for serialization, but keep separate conversations.
Slack text cannot choose a directory, model executable, policy, or arbitrary
configuration override. Unrecognized config keys are rejected.

Read [the boundary prerequisites](security.md), then set `hostPolicyReviewed`
to `true`. The service refuses to start before this explicit operator attestation.
The example deliberately defaults to `false`.

## 2. Create your Slack app

Create a Slack app **from [slack-manifest.json](../slack-manifest.json)** in your
chosen workspace. Review the two bot scopes: `app_mentions:read` and `chat:write`.
Event subscriptions contain only `app_mention`; Socket Mode is enabled. No history
scope, slash command, OAuth callback server, or public request URL is needed.

In the app's Basic Information page, create an **app-level token** with only
`connections:write`. App-level tokens are a separate Slack setup step, not a bot
scope in the manifest. Install your app into your workspace, obtain its bot token,
and invite the bot to each mapped channel. Use ordinary dedicated channels;
externally shared Slack Connect events are rejected in this release.

Set `SLACK_APP_TOKEN` (the `xapp-` token) and `SLACK_BOT_TOKEN` (the `xoxb-` token)
in `/srv/bridge/bridge.env`. Set `BRIDGE_CONFIG` to your private JSON path. Obtain
and enter the bot's user ID and workspace ID; startup verifies them with
`auth.test` before connecting Socket Mode. Allowed human IDs are explicit, never
inferred from display names. Anyone who can read the channel can read its answers,
even if that person cannot ask the bot questions.

Do not install a real app or send test messages as part of repository fixture
verification. Those are separate operator actions for the eventual pilot.

## 3. Authenticate the dedicated Codex runtime

Do not copy a personal `auth.json`. Log in separately as the dedicated account
using the locked CLI and **only** the dedicated home. For example, from the
checkout, with a Node installation in `/usr/local/bin` (adjust this fixed path to
your account's installation):

```sh
env -i HOME=/srv/bridge/codex CODEX_HOME=/srv/bridge/codex \
  PATH=/usr/local/bin:/usr/bin:/bin \
  node node_modules/@openai/codex/bin/codex.js \
  -c 'cli_auth_credentials_store="file"' login --device-auth
```

This is an operator login, not a model turn. Protect the resulting `auth.json`
with mode 0600. Keychain fallback, inherited API keys, custom provider URLs, and
personal configuration are intentionally unsupported. Keep `config.toml` absent
from the dedicated runtime and the project configuration locations described in
the security guide. Do not set `CODEX_HOME` in the **Bridge service** environment;
its JSON selects the dedicated home and Bridge supplies it only to CLI children.

Doctor checks that the dedicated auth file exists and is private; it does not
read its contents, validate expiry, contact the provider, or attest account access.
Only a later authorized live pilot can prove those details.

## 4. Doctor and start

With the private environment already loaded by your process manager, use:

```sh
npm run doctor
npm start
```

Alternatively Node can read the private env file without sourcing shell code:

```sh
node --env-file=/srv/bridge/bridge.env dist/src/main.js doctor
node --env-file=/srv/bridge/bridge.env dist/src/main.js
```

Doctor validates runtime, configuration, access lists, directories, credential
presence, bundled CLI version, disabled features and MCP configuration. It runs
local `--version`, `features list`, and `mcp list --json`, never `exec`. Missing
setup produces exit status 1 and safe messages. Startup repeats those checks;
each model turn rechecks the execution boundary. Existing service state is not
opened or recovered by doctor. Startup checks the schema and acquires the lock.

Run the foreground process under your account's usual service manager. Deliver
SIGTERM or SIGINT for a clean shutdown and allow active Codex cancellation and
Slack sends to finish before force-killing it. Slack sends have a 10-second
request timeout. Do not remove or replace database/lock files while it runs.
There is no incoming HTTP listener. No logs should contain prompts, model output,
provider errors, tokens, or environment dumps; diagnostics contain fixed reason
codes and generated job IDs, with at most 20 diagnostic lines per minute.

## Queue, recovery, and limits

An accepted question gets one acknowledgement and one final outcome (long answers
may occupy multiple messages), all in its originating thread. Only final model
text is sent. Reasoning, commands, tool results and SDK logs are discarded.
`help`, `status`, and `cancel` are deterministic explicit mentions. Cancellation
affects only the caller's pending requests in that thread, or all pending requests
there when a configured operator asks. It cannot retract an already-completed
answer or a request already accepted by the model provider.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `maxPending` | 20 | Total queued plus active requests |
| `maxConcurrentProjects` | 2 | Global active project limit; one turn per real project |
| `maxInputChars` | 12,000 | Prompt limit, counted as JavaScript UTF-16 units |
| `maxOutputChars` | 24,000 | Redacted response budget before Slack escaping |
| `turnTimeoutMs` | 300,000 | Boundary check plus model turn deadline |
| `queueTtlMs` | 900,000 | Maximum wait before a queued request expires |
| `retentionMs` | 604,800,000 | Seven-day metadata and dedup retention |
| `maxRetainedEvents` | 10,000 | Admission stops at this retained event count |

Slack chunks are at most 3,000 UTF-16 units after escaping. Truncation is marked.
`&`, `<`, and `>` are escaped; parsing, markdown, mentions, and unfurls are disabled.
Slack tokens and nonempty values named by `secretEnvNames` are redacted before
truncation/splitting. List additional service secret **environment variable names**
in JSON, never their values. This is exact-value redaction, not a general secret
detector or a guarantee against transformed/unknown secrets.

The service records Slack event IDs before admission; duplicates never launch
another turn. A crash between event admission and acknowledgement can lose that
request, so use `status` and explicitly ask again. Incoming event timestamps older
than the retention window (or over five minutes in the future) are ignored;
keep the host clock synchronized. At dedup capacity, new events are ignored with
a safe local diagnostic rather than evicting retry protection.

An uncertain acknowledgement prevents execution. Model completion is stored
**before** final delivery. Slack retries are disabled for outgoing Web API calls:
a failed or timed-out send may already have arrived. Status reports model state
and uncertain outcome delivery separately. There is no automatic resend or model
retry, including after partial delivery of a long answer. Ask a follow-up explicitly
if you need another answer; that is a new model turn and may incur cost.

On restart, all formerly active **and queued** work becomes `interrupted`, with
prompts removed. Pending/sending delivery becomes `uncertain`. Recovery itself
sends no unsolicited messages; an authorized `status` mention reports the result.
Follow-up mentions resume the last thread ID observed before interruption.
Requests never share a session across workspace/channel/root thread/real project.
Restart after access or project-mapping changes; past state does not grant access.

## Retention and backups

SQLite stores event IDs, necessary routing/request metadata, queued prompts,
session IDs and delivery state, never final answers. Prompt text is cleared when
work becomes terminal. Idle cleanup runs at least once per minute while the
service is running; terminal rows and inactive sessions expire after
`retentionMs` (maximum 30 days). Queue expiry is checked during scheduling and
maintenance. Cleanup runs on startup too; nothing is deleted while the service is
stopped. Persistent active sessions refresh their expiry when used.

SQLite secure deletion is enabled and clean shutdown checkpoints/truncates its
WAL. Retention is logical deletion, **not secure erasure** of old filesystem
blocks, snapshots or backups. The database is bounded by admission count and
configured limits, but the filesystem must still have sufficient free space.

Codex separately persists conversations and runtime data under `codexHome`;
Bridge's retention does **not** delete those files. Slack and the provider also
have independent retention policies. The operator must set a separate lifecycle
for the dedicated Codex home, Slack and backups. Do not delete active Codex
sessions. To reset all conversations, stop Bridge and archive or remove its state
and dedicated Codex home together under your approved data-retention procedure,
then reauthenticate. This is an operator action, never automatic cleanup.

For a consistent backup, stop Bridge cleanly, confirm it has exited, and back up
the **entire** private state and Codex directories together using your secure
backup tool. Protect backups as credentials and project content. Restore them
only to the same trusted account/configuration with no running instance. Restoring
an older snapshot can lose recent dedup information; wait out the retention window
or account for Slack retry history before reconnecting. Never run two restored
copies concurrently. The SQLite lock prevents a second process on the same local
state directory; it is not a distributed lease.

## Development and review

Run the README gates sequentially. Tests use synthetic Slack envelopes, real Bolt
with an injected fetch boundary, real `node:sqlite`, controlled time and a fake
Codex executable launched through the real SDK. CLI configuration checks require
no login. Do not run real model turns or Slack messages for this suite. No custom
visual UI exists, so a browser screenshot is not required.

Runner owns the candidate commit, review and PR publication. Keep human merge
review enabled; do not auto-merge or deploy. The coordinator independently runs
Operations `check-pr` for the exact reviewed head. No Runner dispatch loop or
Operations integration is part of this service.
