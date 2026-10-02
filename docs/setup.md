# Setup and operation

## Native workstation or server

Use Node 24.16.0+ on macOS or Linux and an existing working Codex CLI 0.159.3
setup. The locked dependency provides that CLI under `node_modules/.bin/codex`;
you can select its absolute path or your matching existing executable. No separate
OS account, new CODEX_HOME or fresh login is required. Your existing Codex config,
profiles, MCP servers, apps and permissions remain relevant. Choose the native
`app-server` transport to answer harness approvals and questions through Slack,
or `exec` for an intentionally noninteractive preset. Bridge adds no permission
flags automatically. Choose isolation and permissions to suit your deployment.

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

The manifest sets `features.bot_user.always_online` to `true`, so new apps show
Slack's green availability dot. For an existing app, open
[Your Apps](https://api.slack.com/apps) → your Bridge app → **App Home**, and enable
**Always Show My Bot as Online** under **Your App's Presence in Slack**.
Slack's [bot presence setting](https://docs.slack.dev/apis/web-api/user-presence-and-status/#events-api-bots)
is static for Events API/Socket Mode apps: the dot remains green even if Bridge
stops. It is not a connection or health check. No extra presence scope or polling
is needed; disable the setting if you prefer the default away indicator.

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

`codex.transport` is `"exec"` by default, or `"app-server"` for the native
bidirectional stdio protocol. `codex.args` contains **global CLI options**, before
the selected subcommand.
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

To explicitly pre-approve Bridge's sender for the configured Slack destinations,
set `codex.sendToolApprovalMode` to `"approve"` in the private JSON. This applies
only to the invocation-local `techbase_bridge.send_message` tool; global approvals,
sandbox permissions and other MCP tools retain their normal configuration. Omit
this field to inherit Codex's usual MCP approval behavior. The other supported
[per-tool modes](https://learn.chatgpt.com/docs/extend/mcp#other-configuration-options)
are `"auto"`, `"prompt"` and `"writes"`. With a noninteractive `never` approval
policy, a tool that still requires approval is blocked. Choose the sender
permission and native approval policy as part of operator setup.

For example, an operator who wants the normal workspace sandbox with human
approvals can select the following private preset:

```json
{
  "transport": "app-server",
  "executable": "/absolute/path/to/codex",
  "args": ["-c", "approval_policy=\"on-request\"", "-c", "approvals_reviewer=\"user\""],
  "cwd": "/absolute/path/to/project"
}
```

These are the fields inside `codex`, not the complete Bridge configuration.
No new login or alternate home is required. Native model and tool settings come
from the normal Codex configuration and explicit operator arguments. Approval
policy, reviewer and an explicitly configured sandbox mode are applied when
resuming older sessions, so an old `exec` turn does not keep a stale policy.

Native prompts appear in the originating Slack thread. For one pending prompt,
reply `approve`, `deny`, an option number, or the requested answer. When several
prompts are waiting, use `approve PROMPT_ID`, `deny PROMPT_ID`, or
`answer PROMPT_ID your answer`. Only the requester or a configured operator may
answer; a different thread, expired prompt or duplicate response grants nothing.
Ordinary follow-ups continue the saved Codex conversation after a turn finishes.
With several pending prompts, include the ID rather than queuing an ambiguous
answer. Approval responses accept only the displayed native request, with no
automatic session-wide rules; permission-profile grants are scoped to this turn.
MCP form elicitations accept a JSON object validated against the server's schema.

`status` shows a turn waiting for input. `cancel`, a deadline or shutdown clears
the pending prompts and stops the CLI. Restart interrupts work and never replays
old approvals. Native secret-input requests require direct CLI interaction;
Bridge does not ask for credentials in Slack. Unsupported native client requests
fail visibly rather than being accepted. Account login remains in the normal
harness. Desktop-only interfaces are not provided by this CLI integration.

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
| `turnTimeoutMs` | 300,000 | CLI turn deadline, including waiting for human input; `0` disables it explicitly |
| `queueTtlMs` | 900,000 | Maximum wait before queued work expires |
| `retentionMs` | 604,800,000 | Metadata/session/dedup retention (maximum 30 days) |
| `maxRetainedEvents` | 10,000 | Admission stops at dedup capacity |

Tool sends also have a ten-call limit and a 30-second per-send deadline, checked
between chunks (an in-flight Slack call has a 10-second timeout). Replies support
Slack mrkdwn: `*bold*`, blank lines, bullets and `<https://example.com|label>` links.
Bare HTTP/HTTPS URLs also become clickable. Slack mentions and link/media previews
are disabled. Output is redacted, escaped outside supported web-link controls,
and split into at most 3,000-unit Slack chunks without cutting explicit links.
Raw CLI output is limited to 16 MB per turn and
about 1 MB per JSONL event; excess fails safely. `secretEnvNames` lists additional
environment variable names for exact-value output redaction; their values stay
in the runtime environment because they may be provider credentials. All
Slack-prefixed variables and exact-value aliases are omitted from the CLI env.

## Recovery and retention

Ordinary accepted requests start without an initial queue reply. `status` still
reports queued and active work. Messages with attachments get a text-only notice;
if that notice's delivery is uncertain, Bridge does not execute the request.
Event IDs are claimed before admission; a crash between claim and admission can
lose work rather than replay it.
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
provide a non-root Linux container path. Compose configuration validation has
passed, but the image has not been built or run. Fixture tests do not establish
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
compatible deployment and explicitly evaluate the desired CLI policy. See the
official [agent permissions guidance](https://learn.chatgpt.com/docs/agent-approvals-security).
