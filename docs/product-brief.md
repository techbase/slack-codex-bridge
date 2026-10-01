# Techbase Bridge: first release

Approved on 1 October 2026: a new public Techbase tool, self-hosted with public
source, MIT license. Techbase Bridge is a working product name; repository name
is slack-codex-bridge.

## Job and scope

Make project discussions accessible from one place. An operator maps a dedicated
Slack channel to one local Git project. Authorized people mention the bot to ask
questions, investigate code, develop a plan, and continue that conversation in a
Slack thread. The bot reports acknowledgement, completion, failure, or interruption
in that thread. Accepted work can then enter the existing GitHub/Runner workflow.

The first release delivers that complete conversation path. It does not create
repositories, implement changes, merge PRs, deploy, read arbitrary channel history,
mirror desktop chats, or automatically dispatch Runner cards. Those are potential
subsequent integrations requiring explicit action contracts. There is no website
or new task board inside this tool.

## Core journey

1. Operator installs dependencies, creates an app from the supplied Slack manifest,
   grants only the documented scopes, configures a team, channel/project mapping,
   allowed user IDs, private state directory, and a dedicated Codex home. Secrets
   are environment variables or a private env file, never public config.
2. A local `doctor` validates runtime, configuration, paths, permissions, and Codex
   login availability without sending Slack messages or making a model request.
3. In an allowed channel a person says `@Bridge What would a useful MVP be for this
   project?`. The bot acknowledges in the resulting thread and queues a read-only
   turn against the configured repository. A second explicit mention in that
   thread continues the persisted Codex conversation.
4. `@Bridge help`, `@Bridge status`, and `@Bridge cancel` are deterministic controls,
   not model prompts. Commands apply only to that configured thread; cancellation
   is available to the requester (or an explicitly configured operator). Busy,
   queued, cancelled, interrupted, and failed states are visible without dumping
   command output, reasoning, stack traces, credentials, or stored prompts.
5. The user inspects the final answer and can correct it with another mention.
   Answers must make uncertainty clear; the tool itself does not certify facts or
   silently turn a suggestion into an external action. References to project files
   should remain useful in plain text; no promise of desktop-session synchronization.
6. An interrupted process records unfinished turns as interrupted. It does not
   silently replay possibly executed requests. The person can explicitly ask again.

## Completion criteria

- Runnable headless service with official Bolt Socket Mode and official Codex SDK;
  Node version and dependency versions pinned/documented, reproducible lockfile.
- Only explicit app mentions from configured teams/channels/users reach Codex.
  Bot/system/edit events, oversized requests, unknown channels, and unauthorized
  users cannot enqueue work. Message text cannot pick a project path or policy.
- Persistent sessions scoped by team, channel, root Slack thread, and project;
  durable dedup of Slack event IDs, bounded queue, at most one active turn per
  project, and no accidental session sharing. A follow-up mention resumes.
- Enforced read-only/no-escalation execution and disabled external tools/apps/MCPs
  using supported configuration. Isolated Codex home, minimal child environment
  without Slack tokens. Fail closed on unsupported/unsafe configuration. Document
  the need for a dedicated OS account for a stronger local read-access boundary.
- Final responses escape Slack control syntax, suppress automatic mentions and
  unfurls, split bounded long output safely, and redact configured secrets. Raw
  SDK logs/reasoning/command output are never sent. Failures get a safe explanation
  and local diagnostic correlation, not a false success. A missing completed turn
  is a failure. Slack delivery uncertainty is distinguished from Codex execution.
- Status/help/cancel, clean shutdown, timeout, restart recovery, and retention
  cleanup are implemented. One service instance owns its state directory. No
  duplicate model execution after Slack retries, crash recovery, or cancellation.
- Tests include realistic event fixtures, a controlled fake SDK executable, and
  failure/restart cases. Setup/run/doctor/backup/retention guidance and a manifest
  work together. CI runs meaningful verification. Public examples contain no
  Techbase operator details or private integration settings.

## Pilot evaluation

No efficacy or production-readiness claim before a real pilot. Compare three
ordinary tasks (a code question, a corrected proposal, and an interrupted task)
with using Codex directly. Record accepted answers, correction effort, time, and
cost. A wrong answer must be correctable and cancellation must be intelligible.
Fixture tests establish implementation behavior, not user benefit or live delivery.
The operator still needs to choose a workspace/channel, create the Slack app, and
log in to the dedicated Codex runtime before the first live run.
