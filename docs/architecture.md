# Architecture

Codex transport is selected in private configuration. The compatible `exec`
adapter consumes JSONL events; `app-server` uses Codex's native bidirectional
stdio API for thread start/resume, turns, approvals, questions and MCP elicitations.
Both use the configured executable, cwd and normal account environment, add only
the turn-local Slack sender, preserve existing tools, and save explicit Codex
session IDs. They introduce no project orchestration API.

For native prompts, Bridge transports an opaque harness-owned parser/result.
The harness adapter determines the response shape; Bridge checks the Slack
requester/operator and conversation scope. Replies resolve pending prompts rather
than starting new turns. Prompt IDs are ephemeral, single-use and cancelled with
their native request or turn. Existing SQLite job/session state remains unchanged.

```text
Slack Socket Mode (official Bolt)
  -> authorize ordinary message -> dedup / bounded SQLite queue
  -> fixed Codex CLI child process (no shell, prompt on stdin, JSONL stdout)
       -> MCP stdio send_message -> turn-scoped loopback capability
            -> destination validation / durable delivery intent -> Slack Web API
  -> final answer fallback only when no tool send was attempted
```

`src/config.ts` validates private operator configuration. Slack text cannot choose
process options or sender destinations. `src/slack.ts` subscribes to `message`
events only; the manifest covers public and private channel messages with
`channels:history`, `groups:history` and `chat:write`. No DM, app-mention or slash
command subscription is needed. Mention-only mode filters those same messages.
The app must be a channel member; startup verifies its team/bot identity.

`src/bridge.ts` authorizes workspace, channel and user before storage, reply or
execution. It accepts ordinary human messages and the human `file_share` subtype,
including replies with `thread_ts`. It excludes other subtypes, bot/self/edit/shared
events and stale envelopes. File contents, filenames and download URLs are not
forwarded or fetched. Messages with files queue their text with an explicit
attachment notice; attachment-only messages receive a text-request reply without
starting the CLI. The CLI context also explains this text-only transport limit.
A request gets a queue acknowledgement; an uncertain acknowledgement prevents
execution. Controls are deterministic and cancellation is requester/operator scoped.
The fixed cwd runs one CLI turn at a time, including across incoming channels.

`src/codex.ts` spawns the configured executable directly. Operator arguments are
validated global CLI options followed by an invocation-local MCP override and
`exec --json -`, or `exec --json resume SESSION_ID -`. Only the saved explicit ID
is resumed; never `--last`. Context and the Slack message go on stdin. No shell,
permission override, auth migration, config file edit or session-file access is
involved. HOME, CODEX_HOME when already set, PATH, provider authentication, proxies
and normal environment survive; Slack-prefixed variables and exact aliases of
their values are omitted. Stale Bridge capabilities are replaced per turn.

The adapter consumes bounded JSONL, persists `thread.started` synchronously, and
accepts the last `agent_message` only after a valid `turn.completed` and zero exit.
Reasoning, commands, tool results and stderr are not forwarded. Provider errors
and malformed/oversized streams produce fixed failure codes. A process group and
TERM/KILL escalation implement cancellation; the queue awaits child close and
sender settlement before reuse. This is process cleanup, not an OS security boundary.

`src/mcp-stdio.ts` uses the official MCP SDK and a strict `send_message` schema:
`text`, optional `destination`. `src/mcp.ts` registers it for this invocation using
supported CLI `-c mcp_servers.techbase_bridge=...`. A temporary loopback listener
uses a random turn capability passed through environment, never CLI arguments or
Slack tokens. No endpoint is exposed outside loopback. Doctor reserves the MCP
name and checks that existing entries survive the additive override byte-for-byte
in the CLI listing. It never writes the operator's config. Changes to operator
configuration while Bridge runs require restart and doctor. The listing probe
omits `--strict-config`, which CLI 0.159.3 accepts for execution but rejects for
`mcp list`; the actual execution preset is unchanged.

`src/send.ts` independently validates every tool call and each outbound chunk.
`thread` means the authorized originating channel/root; an alias means a configured
channel's top level. No workspace, raw channel or arbitrary thread argument exists.
It bounds total tool text and number of sends, serializes sends, and writes delivery
intent before Slack. Uncertainty disables further tool sends for the turn. The CLI
gets delivery guidance, not instructions restricting what work it may perform.
Any tool attempt suppresses a successful final fallback, preventing duplicate
answers after success, partial delivery or an uncertain send. A later CLI failure,
timeout, cancellation or shutdown gets a distinct terminal notice, without
repeating the tool message or erasing prior delivery uncertainty. `status` reports
CLI outcome and Slack delivery separately.

`src/store.ts` retains schema version 1: dedup events, jobs and session IDs keyed
by workspace/channel/root/cwd. Prompts are cleared at terminal state; answers are
never stored. Startup marks queued/active jobs interrupted and pending/sending
delivery uncertain. It never reruns work or sends on recovery. SQLite's local
instance lock prevents two services using one state directory; it is not a
cross-host coordinator. Retention and admission bounds stay in the existing store.

`src/doctor.ts` checks setup, built MCP entry point, configured CLI version/help and
MCP listing without a model or Slack call. `src/main.ts` owns startup, identity
verification, bounded safe diagnostics and awaited shutdown. There is no custom UI
or browser journey. Node 24.16+ on macOS/Linux and CLI 0.159.3 are the release
contract; Docker remains an optional, explicitly unverified example in this change.
