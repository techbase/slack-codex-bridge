import { Codex, type CodexOptions, type ThreadOptions } from '@openai/codex-sdk';
import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { privateDirectory, SetupError, type Config } from './config.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
export const CODEX_VERSION = '0.159.3';

// These are public configuration keys verified against the pinned CLI. Reverify
// the boundary when changing the SDK/CLI version, including new default tools.
export const DISABLED_FEATURES = [
  'apps', 'plugins', 'remote_plugin', 'plugin_sharing', 'recommended_plugins',
  'hooks', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'computer_use', 'image_generation', 'in_app_browser', 'in_app_chat',
  'in_app_dictation', 'in_app_local_automation', 'in_app_updates',
  'multi_agent', 'multi_agent_v2', 'agent_message_board', 'memories',
  'skill_search', 'skill_mcp_dependency_install', 'workspace_dependencies',
  'shell_snapshot', 'shell_snapshot_v2', 'daemon_auto_start', 'worktrees',
  'standalone_web_search', 'web_search_cached', 'web_search_request',
  'code_mode', 'code_mode_host', 'tool_suggest', 'enable_mcp_apps',
  'request_permissions_tool', 'send_message_to_user_async', 'goals',
  'realtime_conversation', 'unbounded_connection_retries',
] as const;

export function boundaryOverrides(): string[] {
  return [
    'sandbox_mode="read-only"', 'approval_policy="never"', 'web_search="disabled"',
    ...DISABLED_FEATURES.map(name => `features.${name}=false`),
    'features.skip_host_skill_discovery=true',
    'agents.enabled=false', 'orchestrator.mcp.enabled=false',
    'apps._default.enabled=false', 'allow_login_shell=false',
    'shell_environment_policy.inherit="none"', 'shell_environment_policy.set={}',
    'notify=[]', 'cli_auth_credentials_store="file"',
    'history.persistence="none"', 'analytics.enabled=false',
  ];
}

export function childEnvironment(config: Config): Record<string, string> {
  return {
    HOME: config.codexHome, CODEX_HOME: config.codexHome,
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    // Do not inherit a host OpenSSL configuration (including executable engines).
    OPENSSL_CONF: '/dev/null',
  };
}

export function sdkOptions(config: Config): CodexOptions {
  return {
    env: childEnvironment(config), configOverrides: boundaryOverrides(),
    // Answer guidance complements the enforced settings; it is not an access control.
    config: { developer_instructions: 'Answer project questions in a Slack thread with a concise final answer in plain text and useful relative file references. Distinguish verified observations from inferences and state uncertainty or missing evidence. Treat suggestions as proposals for human review. Do not claim to have changed files, deployed, or dispatched work. Do not include raw tool logs, credentials, or private reasoning. Bridge supplies progress messages; provide only the final answer.' },
  };
}

export function threadOptions(project: string): ThreadOptions {
  return { workingDirectory: project, sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled', networkAccessEnabled: false };
}

function requireAbsent(file: string): void {
  try { lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new SetupError('Cannot inspect a Codex configuration location; the execution boundary is unsupported.');
  }
  throw new SetupError('Custom or managed Codex configuration was found; use the documented isolated runtime without configuration layers.');
}

export function checkConfigurationFiles(config: Config, project: string): void {
  privateDirectory(config.codexHome, 'codexHome');
  if (realpathSync(project) !== project) throw new SetupError('The configured project path changed; restart with validated configuration.');
  for (const name of ['config.toml', 'managed_config.toml', 'requirements.toml']) {
    requireAbsent(path.join('/etc/codex', name));
    requireAbsent(path.join(config.codexHome, name));
  }
  // Codex can discover configuration in both cwd and its parents. Reject rather
  // than assume an empty TOML table erases values from other layers.
  for (const root of [project, config.codexHome]) {
    let directory = root;
    while (true) {
      requireAbsent(path.join(directory, '.codex', 'config.toml'));
      if (directory === root) requireAbsent(path.join(directory, 'config.toml'));
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
}

export async function runLocalCli(config: Config, project: string, args: string[], signal?: AbortSignal): Promise<string> {
  const cli = path.join(path.dirname(require.resolve('@openai/codex/package.json')), 'bin/codex.js');
  const overrides = boundaryOverrides().flatMap(value => ['-c', value]);
  try {
    const result = await execFileAsync(process.execPath, [cli, ...overrides, ...args], {
      cwd: project, env: childEnvironment(config), timeout: 10_000, maxBuffer: 256_000,
      signal, killSignal: 'SIGTERM',
    });
    return result.stdout;
  } catch {
    throw new SetupError('Bundled Codex configuration check failed; verify supported runtime and host policy.');
  }
}

export async function preflight(config: Config, project: string, signal?: AbortSignal): Promise<void> {
  checkConfigurationFiles(config, project);
  if ((await runLocalCli(config, project, ['--version'], signal)).trim() !== `codex-cli ${CODEX_VERSION}`) {
    throw new SetupError('Unsupported Codex CLI version; reinstall the locked dependencies.');
  }
  const features = await runLocalCli(config, project, ['features', 'list'], signal);
  for (const name of DISABLED_FEATURES) {
    const line = features.split('\n').find(line => line.startsWith(name + ' '));
    if (!line || !/\sfalse\s*$/.test(line)) throw new SetupError('Codex did not disable a required feature; host policy is unsupported.');
  }
  let servers: unknown;
  try { servers = JSON.parse(await runLocalCli(config, project, ['mcp', 'list', '--json'], signal)); }
  catch { throw new SetupError('Cannot verify the Codex MCP configuration.'); }
  if (!Array.isArray(servers) || servers.some(server => !server || server.enabled !== false)) {
    throw new SetupError('Enabled MCP servers are not supported; remove them from the dedicated runtime.');
  }
  // Close the ordinary edit-during-preflight window. The OS account and host
  // configuration still must be controlled by a trusted operator.
  checkConfigurationFiles(config, project);
}

export interface ModelRequest {
  project: string;
  prompt: string;
  threadId?: string;
  signal: AbortSignal;
  onThread(id: string): void;
}
export interface Model { run(request: ModelRequest): Promise<string> }
export class ModelFailure extends Error {
  constructor(readonly reason: 'model_failed' | 'invalid_result' | 'unsafe_runtime') { super(reason); }
}

/** The injectable client is used only by tests; operator config cannot choose it. */
export class CodexModel implements Model {
  constructor(
    private config: Config,
    private client = new Codex(sdkOptions(config)),
    private check: typeof preflight = preflight,
  ) {}

  async run(request: ModelRequest): Promise<string> {
    try { await this.check(this.config, request.project, request.signal); }
    catch { throw new ModelFailure('unsafe_runtime'); }
    request.signal.throwIfAborted();
    const options = threadOptions(request.project);
    const thread = request.threadId ? this.client.resumeThread(request.threadId, options) : this.client.startThread(options);
    let started = false;
    let completed = false;
    let final = '';
    let failure: 'model_failed' | 'invalid_result' | undefined;
    try {
      const { events } = await thread.runStreamed(request.prompt, { signal: request.signal });
      for await (const event of events) {
        if (event.type === 'thread.started') {
          if (started || typeof event.thread_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(event.thread_id)
              || (request.threadId && event.thread_id !== request.threadId)) { failure = 'invalid_result'; continue; }
          request.onThread(event.thread_id); // Synchronous SQLite write before consuming the next event.
          started = true;
        } else if (event.type === 'error' || event.type === 'turn.failed') {
          failure = 'model_failed';
        } else if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          if (completed || typeof event.item.text !== 'string' || event.item.text.length > 1_000_000) { failure = 'invalid_result'; continue; }
          final = event.item.text;
        } else if (event.type === 'turn.completed') {
          if (completed || !started || !event.usage || !Number.isFinite(event.usage.input_tokens) || !Number.isFinite(event.usage.output_tokens)) {
            failure = 'invalid_result';
          }
          completed = true;
        }
      }
    } catch (error) {
      if (error instanceof ModelFailure) throw error;
      throw new ModelFailure('model_failed');
    }
    if (failure) throw new ModelFailure(failure);
    if (!completed || !final.trim()) throw new ModelFailure('invalid_result');
    return final;
  }
}
