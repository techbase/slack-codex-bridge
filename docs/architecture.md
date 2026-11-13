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
their native request or turn. SQLite schema 2 adds the accepted Slack message timestamp to each job; existing job/session identities are preserved.

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
Replies carry their accepted Slack timestamp through the durable queue. Immediately before a model turn, Bridge reads only the exact own-bot parent in the already authorized incoming channel. The bounded, text-only parent is passed as untrusted historical reference separately from the human request, for both transports. Root edits after the reply, truncation and unavailable reads are explicit. Other authors and attachment contents are excluded; known secrets are redacted. Reads do not reorder admission or grant a native approval. Cancellation prevents a pending root read from starting a model turn; SDK HTTP settlement remains bounded by its existing timeout. Deterministic controls and native prompt responses bypass the context read.

Ordinary requests are admitted without a queue reply. The optional attachment
notice must be delivered before execution; an uncertain notice prevents execution.
The existing SQLite `ack` column records this notice as pending, sent, uncertain
or skipped, preserving the database schema and existing session state.
Controls are deterministic and cancellation is requester/operator scoped.
A conversation lane is keyed by workspace/channel/root/cwd. Each lane has one
active turn; independent lanes run concurrently up to `maxConcurrentTurns`
(default four, maximum sixty-four). Different lanes sharing a saved native chat ID
also serialize. Native prompt/cancel scope stays exact. Accepted queue entries
have no time-based execution expiry; admission remains bounded by `maxPending`.
Attachment notices preserve FIFO within their lane without blocking other lanes.

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

`src/store.ts` uses additive schema 3: dedup events, jobs and session IDs keyed
by workspace/channel/root/cwd. Execution prompts are cleared at terminal state;
request context and outcome summaries are retained up to 4,000 units each with
truncation flags. Native turn/chat IDs and explicit outcome delivery are separate
from progress delivery. Startup interrupts active work without replay, while
acknowledged unstarted jobs remain queued. Uncertain/pending attachment notices
interrupt their jobs. Pending delivery on unstarted jobs stays pending; potentially
attempted delivery becomes uncertain. Recovery itself sends nothing. SQLite's local
instance lock prevents two services using one state directory; it is not a
cross-host coordinator. Retention and admission bounds stay in the existing store.

`src/doctor.ts` checks setup, built MCP entry point, configured CLI version/help and
MCP listing without a model or Slack call. `src/main.ts` owns startup, identity
verification, bounded safe diagnostics and awaited shutdown. There is no custom UI
or browser journey. Node 24.16+ on macOS/Linux and CLI 0.159.3 are the release
contract; Docker remains an optional, explicitly unverified example in this change.

Native interactions declare whether they require approval or typed input. A
normal conversational follow-up during an approval wait is queued before
interrupting that turn. It resumes the same session after child exit, without
responding to or granting any native approval. Only the requester or an operator
may interrupt the wait. With several approval prompts, explicit controls still
require an ID; ordinary conversation withdraws the blocked turn. Native question
and form input remains validated rather than treated as a follow-up.

## Human message extension contract

Private configuration may set `humanMessageCommand` to fixed absolute argv.
Bridge sends JSON `{version:1,phase:"message",eventId,messageTs,team,channel,root,actor,project,text,parent?}`
on stdin. The child returns `{handled:boolean,response?:string,context?:unknown,receipt?:string}`.
Handled responses require nonempty text; unhandled results may add JSON-framed
untrusted model context. Native prompt responses and deterministic controls
bypass the extension. Input text never selects its executable or arguments.

A handled response with a receipt receives a second call carrying the same
accepted event plus `phase:"delivery",receipt,delivered:boolean`. A positive
acknowledgement means all response chunks were confirmed. Uncertain/partial
delivery must not authorize an unshown proposal. Acknowledgement errors are
safely diagnosed without changing the delivered job result or retrying effects.
The child has a 20-second bound and 64,000-character output cap; cancellation
kills/reaps its process group. State belongs to the configured extension.

## Read-only lifecycle snapshot

An operator can run the built entry point with the same private configuration:

```sh
BRIDGE_CONFIG=/absolute/private/bridge.config.json node dist/src/main.js snapshot <<'JSON'
{"limit":50}
JSON
```

This bypasses doctor, Slack authentication/calls, model execution, instance locks
and startup recovery. It opens the existing SQLite database read-only. The input
is bounded JSON with optional `limit` (1–100) and opaque `cursor`. The response is
`{version:1,generatedAt,jobs,nextCursor}`, ordered by stable creation time/job ID.
Each job supplies its exact admitted route/actor/event, bounded text, transport
state/reason, progress delivery, separate `outcomeDelivery`
(`unknown|sent|uncertain`), native identities, timestamps and bounded outcome.
Only records inside the current operator incoming policy, user allowlist and cwd
are exported. Joined mode exports admitted channel origins, including their
retained history after removal; it never exports DMs. Unknown
final-delivery evidence is never promoted from a progress post. Schema-1/2 reads
do not migrate files and may lack historical text/outcome proof.

A private consumer can reconcile idempotently by workspace/job ID and follow
`nextCursor`. Absence from one page or a later retention-pruned snapshot
does not mean a higher-level commitment is complete. The consumer owns its own
retention and evidence policy; this transport adds no scheduler or project engine.

Native turn reconciliation uses only the invocation's own app-server connection.
An idle observation or 30-second probe checks exact chat/turn metadata; a completed
turn requires terminal evidence for that owned turn and an observed final message.
Active, unavailable, foreign and merely not-loaded states do not establish
completion. This is lifecycle reconciliation, not an arbitrary execution timeout
or permission to replay work.
