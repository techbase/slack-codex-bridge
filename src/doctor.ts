import { accessSync, constants } from 'node:fs';
import { preflight } from './codex.js';
import { type Config, SetupError } from './config.js';
import { MCP_ENTRY } from './mcp.js';

export interface DoctorCheck { check: string; ok: boolean; detail: string }

export async function doctor(config: Config, env = process.env): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });
  add('runtime and configuration', true, 'Supported Node/platform; routing, preset and private state path validated.');
  // No state recovery, authentication inspection, Slack sends or model execution.
  try { accessSync(config.stateDir, constants.R_OK | constants.W_OK | constants.X_OK); add('state directory', true, 'Accessible. Startup acquires the SQLite instance lock and validates the schema.'); }
  catch { add('state directory', false, 'State directory must be readable and writable by the service account.'); }
  for (const token of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']) {
    const valid = token === 'SLACK_BOT_TOKEN' ? /^xoxb-\S+$/.test(env[token] ?? '') : /^xapp-\S+$/.test(env[token] ?? '');
    add(token, valid, valid ? 'Present; identity is checked at startup.' : 'Missing or invalid; configure the Slack app token.');
  }
  for (const name of config.secretEnvNames) add('configured redaction value', !!env[name], env[name] ? 'Present.' : 'A configured secret environment variable is missing.');
  try { accessSync(MCP_ENTRY, constants.R_OK); add('Bridge MCP build', true, 'Stdio entry point is available.'); }
  catch { add('Bridge MCP build', false, 'Run npm run build.'); }
  try { await preflight(config, env); add('Codex CLI', true, `Pinned CLI supports ${config.codex.transport === 'app-server' ? 'native app-server stdio' : 'stdin/JSON/resume'}; invocation-local Bridge MCP preserves existing MCP configuration. No model turn run.`); }
  catch (error) { add('Codex CLI', false, error instanceof SetupError ? error.message : 'CLI probe failed.'); }
  add('Codex environment', true, 'Inherited from the normal runtime and explicit preset. Authentication validity and execution permissions remain untested; use your already-working Codex setup.');
  return checks;
}
