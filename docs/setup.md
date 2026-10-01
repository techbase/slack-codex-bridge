# Setup and operation

## Native workstation or server

Use Node 24.16.0+ on macOS or Linux and an existing working Codex CLI 0.159.3
setup. The locked dependency provides that CLI under `node_modules/.bin/codex`;
you can select its absolute path or your matching existing executable. No separate
OS account, new CODEX_HOME or fresh login is required. Your existing Codex config,
profiles, MCP servers, apps and permissions remain relevant. Verify that the
chosen preset can operate noninteractively; Bridge does not implement an approval
conversation or add permission flags. A request that cannot proceed can fail or
reach its timeout. Choose isolation and permissions to suit your deployment.

```sh
npm ci
npm run build
mkdir -p /your/private/bridge/state
chmod 700 /your/private/bridge/state
cp examples/bridge.config.json /your/private/bridge/bridge.config.json
chmod 600 /your/private/bridge/bridge.config.json
```

Replace the fictional paths/IDs in the copied JSON. `stateDir` must be canonical,
owned by the service user, mode 0700, without symlink components. Keep it and the
config outside public Git. On macOS, use a canonical path rather than a `/var` or
`/tmp` symlink. `codex.cwd` must be an existing absolute directory. Codex's own
Git/trust/configuration requirements still apply there. Configuration JSON has no
secrets; put Slack tokens in a private environment file (mode 0600) or your normal
service secret mechanism. Bridge does not automatically read `.env` files.

Set `BRIDGE_CONFIG` to the private JSON path and `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`
in the process environment using your normal shell or service manager. Preserve
the HOME, PATH, CODEX_HOME if used, and provider/auth environment of your working
Codex installation. Then run `npm run doctor` and `npm start` from the checkout.
A native service manager may invoke `node /absolute/bridge/dist/src/main.js`
directly with the same environment; no bundled scheduler or installer is required.
You can also load your private environment file explicitly with Node:

```sh
node --env-file=/your/private/bridge/bridge.env dist/src/main.js doctor
node --env-file=/your/private/bridge/bridge.env dist/src/main.js
```

Stop with SIGINT/SIGTERM and allow admitted sends/process cleanup to settle.

Doctor checks config/path validity, token presence (without printing values), the
built sender, CLI version/help, and a no-model MCP listing with the invocation-local
sender. It does not inspect/copy auth files, call Slack, run a model, verify login
expiry, attest OS sandbox enforcement or reject normal Codex configuration.
Startup additionally checks the Slack token's team/bot identity and acquires the
single-instance SQLite lock. A configured executable is trusted operator code;
Bridge cannot make a malicious executable's `--help` or `--version` safe.

## Slack app

Create an app from [slack-manifest.json](../slack-manifest.json), enable Socket
Mode, and create an app-level token with `connections:write`. Install it in the
single intended workspace. Bot scopes are `channels:history`, `groups:history`
and `chat:write`; bot events are `message.channels` and `message.groups`.
If you only use one channel type, you can remove its unused counterpart event and
history scope from your app. There are no DM, `app_mention` or slash-command
subscriptions. Do not add `chat:write.public`: invite the bot to every incoming
and outgoing channel instead. Set team, bot-user and permitted human-user IDs
explicitly. Bridge does not discover channels or expand access from Slack text.

**Migrating an old app:** update subscriptions/scopes from the former
`app_mention`/`app_mentions:read` manifest, reinstall/re-authorize the app to grant
history scopes, and invite it to the configured channels. Changing repository
JSON alone does not update a Slack installation. Ordinary authorized human
messages now trigger by default; set `mentionOnly: true` if that is your chosen
channel behavior. Both modes use the same `message` subscription, preventing
double event delivery from parallel mention/message listeners.

## Configuration

[examples/bridge.config.json](../examples/bridge.config.json) is fictional. The
operator fixes incoming IDs and outgoing alias-to-ID mappings. `thread` is a
reserved implicit destination for replies in the originating Slack thread. An
explicit alias posts at the top level of that configured outgoing channel, even
if it maps to the incoming channel. An empty outgoing map allows only thread replies.
Everyone with channel visibility may read output, including people not allowed
to invoke Bridge. Do not configure aliases with inappropriate audiences.

`codex.args` contains **global CLI options**, before Bridge's `exec` subcommand.
Use separate argument/value entries, for example `["--profile", "slack"]` or
`["--sandbox", "workspace-write", "--ask-for-approval", "never"]` only if those are
your intended permissions. Supported value options are `--config`/`-c`,
`--profile`/`-p`, `--model`/`-m`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`,
`--enable`, `--disable`, `--local-provider` and `--add-dir`. Supported flags are
`--oss`, `--search`, `--approve-for-me`, `--no-daemon`, `--strict-config` and the
CLI's two explicit `--dangerously-bypass-*` flags. Those dangerous flags are never
added by Bridge and are absent from examples. Command names, prompt operands,
`--last`, `--cd`, output-file and ephemeral-session options are not accepted.
Use `codex.cwd` for the fixed working directory. Do not put secrets in argv/config
overrides: command arguments can appear in local process listings.

The MCP name `techbase_bridge` is reserved. Doctor rejects an existing entry of
that name instead of overwriting it. Other existing MCP entries are preserved.
Restart and run doctor after changing access, destinations, preset or Codex
configuration. Session keys include cwd; changing the preset at the same cwd
continues existing threads. Use a new Slack thread for fresh context. No process
edits Codex session files or chooses the global last session.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `maxPending` | 20 | Queued plus active requests; one CLI turn at a time |
| `maxInputChars` | 12,000 | Incoming prompt limit in UTF-16 units |
| `maxOutputChars` | 24,000 | Final fallback budget; total tool text budget per turn |
| `turnTimeoutMs` | 300,000 | CLI turn deadline; cleanup waits for process/send settlement |
| `queueTtlMs` | 900,000 | Maximum wait before queued work expires |
| `retentionMs` | 604,800,000 | Metadata/session/dedup retention (maximum 30 days) |
| `maxRetainedEvents` | 10,000 | Admission stops at dedup capacity |

Tool sends also have a ten-call limit and a 30-second per-send deadline, checked
between chunks (an in-flight Slack call has a 10-second timeout). Output is redacted, escaped, and split into
at most 3,000-unit Slack chunks. Raw CLI output is limited to 16 MB per turn and
about 1 MB per JSONL event; excess fails safely. `secretEnvNames` lists additional
environment variable names for exact-value output redaction; their values stay
in the runtime environment because they may be provider credentials. All
Slack-prefixed variables and exact-value aliases are omitted from the CLI env.

## Recovery and retention

An accepted request gets one queue acknowledgement. If its delivery is uncertain,
Bridge does not execute the request. Event IDs are claimed before admission;
a crash between claim and acknowledgement can lose work rather than replay it.
Events older than retention or over five minutes in the future are ignored.
Keep host clocks synchronized. At dedup capacity, new events are ignored with a
safe local reason code rather than evicting retry protection.

`help`, `status`, `cancel` (case insensitive, optional bot mention) are controls,
not model prompts. Cancellation affects the caller's requests in the current
thread; configured operators may cancel any request there. Cancellation cannot
undo completed filesystem/external actions or already accepted Slack/provider work.

CLI completion is saved before automatic final delivery. Tool sends persist
intent before Slack calls. Slack Web API retries are disabled, including for rate
limits. A timeout/error can mean Slack accepted the message: delivery becomes
`uncertain`, later tool sends stop, and no automatic final fallback or resend
occurs. Partial long-answer delivery has the same rule. After a tool send, use
`status` to see the CLI outcome if it later failed or was cancelled. Asking again
explicitly is new work and may repeat actions or incur model cost.

On restart, formerly queued and active jobs become `interrupted`; pending/sending
deliveries become `uncertain`. Recovery sends nothing and never executes old work.
Follow-ups use the last observed explicit session ID, which may contain a partial
turn. The existing version-1 SQLite schema is retained. To migrate from the pilot,
stop it, replace old JSON with the new format, and reuse its private state directory
if you want retained dedup and matching cwd/thread sessions. Its isolated Codex
sessions are not copied: continuation requires the selected runtime to have the
saved session. Start a new Slack thread if it does not. Old `codexHome`,
`hostPolicyReviewed`, `channels` and `maxConcurrentProjects` settings are rejected
with a migration message; no silent legacy fallback remains.

Terminal prompts are removed immediately; idle cleanup runs at least every minute.
Bridge stores metadata/session IDs, never final answers. SQLite secure deletion
and WAL checkpointing do not erase filesystem snapshots/backups. Codex, Slack and
the model provider retain their own data independently; Bridge does not delete it.
Back up private state using your normal secure procedure while Bridge is stopped.
Restore to one instance with the matching configuration; old backups can lose
recent dedup records, so account for Slack retry history before reconnecting.

## Optional Docker example — unverified

[Dockerfile](../Dockerfile) and [examples/compose.yaml](../examples/compose.yaml)
provide a non-root Linux container path. They have not been built/run in this
assignment: the available Docker client reports no daemon at its configured socket. Compose configuration validation passed using the
installed Compose plugin directly. Native macOS fixture results do not establish
container or Linux sandbox behavior.

Set the path variables shown in [examples/docker.env.example](../examples/docker.env.example)
in a private Compose environment file. Create state and Codex storage directories
owned by the image's `node` user (UID 1000), with private permissions, using your
ordinary host administration process. Adapt UID ownership to your deployment;
Bridge does not provision accounts or change host permissions for you. Use the
[container configuration template](../examples/bridge.docker.config.json).
The project is an explicit bind mount; choose read-only or writable according to
your intended CLI policy. Codex's normal `/home/node/.codex` is explicitly mounted
for persistent configuration/auth/session state. Authenticate/configure that runtime
through Codex's supported operator flow, or use your established provider auth
mechanism. Do not bake credentials into an image or copy someone else's login.

```sh
docker compose --env-file /private/bridge/docker.env -f examples/compose.yaml build
docker compose --env-file /private/bridge/docker.env -f examples/compose.yaml run --rm bridge doctor
docker compose --env-file /private/bridge/docker.env -f examples/compose.yaml up bridge
```

No published ports, Docker socket mount, privileged mode, host networking or
sandbox-bypass flags are included. An init process reaps children. Nested Codex
sandboxing depends on host/kernel/container support and may fail; doctor does not
exercise it. Do not disable the sandbox just to pass a smoke check. Select a
compatible deployment or explicitly evaluate the operator's desired policy outside
this implementation assignment. See the official
[agent permissions guidance](https://learn.chatgpt.com/docs/agent-approvals-security).
The supplied upstream `.devcontainer/README.md` link was unavailable during this
review; it is not evidence that this example supports a particular nested sandbox.
