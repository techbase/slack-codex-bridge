# Execution boundary and limits

Bridge authorizes an explicit app mention using the workspace, channel and human
allowlists **before** persisting a prompt, replying, or invoking Codex. It ignores
bot/system/edit events, shared-channel events, implicit mentions and stale event
envelopes. The configured real project path fixes each turn's working directory.
Prompts cannot change process arguments or select a different policy.

## Enforced local settings

The official SDK is pinned to 0.159.3 with its matching CLI. Bridge uses supported
`env`, `configOverrides`, `startThread`, `resumeThread`, `runStreamed`, and
`AbortSignal` APIs. The settings are defined in [src/codex.ts](../src/codex.ts):

- Read-only sandbox, approval policy `never`, disabled web search, and disabled
  sandbox network access. No additional writable directories or skipped Git check.
- Disabled apps, plugins, remote plugins, hooks, browser/computer tools, image
  generation, subagents, skill installation/search, workspace dependencies,
  memories, daemon startup, worktrees, code mode, and other external tool features.
- No enabled MCP servers. **An empty `mcp_servers` override is insufficient**:
  the pinned CLI merges it with inherited settings. Bridge rejects configuration
  layers and checks the local MCP listing instead of relying on that override.
- A dedicated `CODEX_HOME` and `HOME`; a fixed system `PATH`, locale and empty
  OpenSSL configuration. No inheritance of Slack tokens, API keys, proxy variables,
  personal shell settings or arbitrary service environment values. The SDK adds
  its originator marker and bundled utility path; macOS may add its text-encoding
  environment value. Model shell commands use `inherit="none"` and cannot request
  login shells. Codex authentication is deliberately file-based in the dedicated
  home, without personal keychain fallback.

Separate developer instructions request concise answers, useful file references,
and an explicit distinction between observations and uncertainty. This guidance
does not enforce access or guarantee factual accuracy.

The local CLI preflight verifies version, disabled feature flags, and MCP status
before startup and every model turn. Unreadable configuration locations and any
known custom configuration fail closed. It rejects `/etc/codex/config.toml`,
`requirements.toml`, and `managed_config.toml`; the corresponding files in the
dedicated home; `config.toml` at the project/home root; and ancestor
`.codex/config.toml` files. This restrictive first release does not attempt to
merge arbitrary operator or project configuration safely.

These decisions were checked against the [pinned public configuration schema](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/core/config.schema.json)
and the [pinned configuration loader](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/config/src/loader/mod.rs),
plus no-model CLI probes. Dependency updates require repeating those probes and
the actual SDK fake-executable tests; passing a flag to an unsupported version
does not establish a boundary.

## Host prerequisites

Use a dedicated unprivileged OS account on a host with working Codex OS sandbox
support. Do not use a root account, a personal account with unrelated readable
projects, or a host where the OS sandbox is disabled. Model answers may expose
anything that this account and Codex can read. Read-only means no permitted
filesystem writes by model tools; **it does not confine reads to the project**.
The trusted Codex process itself writes its sessions/auth/runtime state.

System/MDM and account/cloud requirements can affect Codex policy, including
fallbacks to required values. This release does not support managed environments
that impose such policy. The operator must verify that there is no MDM or cloud
policy changing permissions, enabling tools/hooks, or replacing endpoints.
`hostPolicyReviewed: true` records that prerequisite; it is **not automatic proof**
that policy is absent. Doctor cannot attest hidden managed policy or OS sandbox
efficacy, and Bridge cannot defend against an administrator or another same-account
process changing configuration between validation and launch. If you cannot
establish these prerequisites, do not enable the service.

Keep the service checkout, installed dependencies, configuration, home and parent
directories under trusted operator control. Prevent other accounts from changing
paths, replacing state files or modifying the executable. The service checks
private ownership/modes and rejects symlinked state/home locations. State files
must be private regular files without hard links. The database lock does not
protect against deliberate file removal or copying by the operator.

## Information flow and cancellation

Slack and the model provider receive prompts/results under their own policies.
Provider connectivity remains necessary even though model shell network access
is disabled. An allowlisted requester is not the only reader of a Slack thread;
everyone with channel visibility may see the answer. Do not map projects with
secrets or information inappropriate for that audience.

Output filtering blocks Slack control syntax and redacts configured exact secret
values. It cannot recognize every project secret, transformed credential, or
information disclosure. Neither read-only sandboxing nor a minimal child
environment guarantees that readable files or same-account process information
contain no secrets. Do not treat a prompt as an access control.

Cancellation aborts the SDK stream and awaits the admitted turn before another
turn uses that project or shutdown releases state. It cannot undo model-provider
work, Slack delivery, or an already completed turn. The process may already have
persisted a partial conversation; a follow-up resumes the last observed ID.
Malformed/absent final results fail safely, and provider error payloads are never
shown in Slack or logs. A network send failure has ambiguous delivery and never
causes the completed model turn to be replayed.

Fixture verification establishes routing, lifecycle, durable state, safe output,
and the real SDK's options/environment. Real Slack installation and messages,
provider authentication and model turns, macOS/Linux OS sandbox enforcement and
managed-policy behavior are separate, unperformed integration checks. No
production-readiness, confidentiality certification, or model-accuracy claim is
made by this implementation.
