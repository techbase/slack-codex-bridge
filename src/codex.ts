import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { SetupError, type Config } from './config.js';
import { MCP_NAME, mcpOverrides, openSender } from './mcp.js';
import type { SendMessage } from './send.js';

export const CODEX_VERSION = '0.159.3';

export function childEnvironment(env = process.env): Record<string, string> {
  const slackValues = new Set(Object.entries(env).filter(([name]) => /^SLACK_/i.test(name)).map(([, value]) => value).filter(Boolean));
  return Object.fromEntries(Object.entries(env).filter(([name, value]) =>
    value !== undefined && !/^SLACK_/i.test(name) && !slackValues.has(value)
    && !['BRIDGE_SEND_URL', 'BRIDGE_SEND_TOKEN'].includes(name))) as Record<string, string>;
}

export class ModelFailure extends Error {
  constructor(readonly reason: 'model_failed' | 'invalid_result' | 'cli_unavailable') { super(reason); }
}

/** One process group per invocation, no shell; await termination before reuse. */
function invoke(config: Config, args: string[], input: string, env: Record<string, string>, signal: AbortSignal,
  onLine: (line: string) => void, maxBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ModelFailure('model_failed')); return; }
    const child = spawn(config.codex.executable, args, { cwd: config.codex.cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let failure: ModelFailure | undefined;
    let buffer = '';
    let bytes = 0;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try { process.kill(-child.pid, signal); }
        catch { child.kill(signal); }
      }
    };
    const stop = (reason: ModelFailure) => {
      failure ??= reason;
      if (killTimer) return;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 1000);
    };
    const abort = () => stop(new ModelFailure('model_failed'));
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => { failure ??= new ModelFailure('cli_unavailable'); });
    child.stdin.on('error', () => stop(new ModelFailure('model_failed')));
    child.stderr.resume(); // Raw CLI/provider diagnostics never reach logs or Slack.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      if (failure) return;
      bytes += Buffer.byteLength(data);
      buffer += data;
      if (bytes > maxBytes || buffer.length > 1_100_000) { stop(new ModelFailure('invalid_result')); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          try { onLine(line); }
          catch (error) { stop(error instanceof ModelFailure ? error : new ModelFailure('invalid_result')); return; }
        }
      }
    });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      // The CLI owns its descendants; do not leave an MCP child behind.
      killGroup('SIGKILL');
      if (!failure && buffer.trim()) {
        try { onLine(buffer); }
        catch (error) { failure = error instanceof ModelFailure ? error : new ModelFailure('invalid_result'); }
      }
      if (failure || code !== 0 || signal.aborted) reject(failure ?? new ModelFailure('model_failed'));
      else resolve();
    });
    child.stdin.end(input);
  });
}

export async function runLocalCli(config: Config, args: string[], env = process.env): Promise<string> {
  const lines: string[] = [];
  await invoke(config, [...config.codex.args, ...args], '', childEnvironment(env), AbortSignal.timeout(10_000), line => lines.push(line), 256_000);
  return lines.join('\n');
}

export async function listMcp(config: Config, includeBridge: boolean, env = process.env): Promise<unknown> {
  // CLI 0.159.3 accepts this flag for exec but explicitly rejects it for mcp.
  // Keep it on real execution/help probes; omit it only on configuration listing.
  const listingConfig = { ...config, codex: { ...config.codex, args: config.codex.args.filter(arg => arg !== '--strict-config') } };
  return JSON.parse(await runLocalCli(listingConfig, [...(includeBridge ? mcpOverrides(config.codex.sendToolApprovalMode) : []), 'mcp', 'list', '--json'], env));
}

export async function preflight(config: Config, env = process.env): Promise<void> {
  try {
    if ((await runLocalCli(config, ['--version'], env)).trim() !== `codex-cli ${CODEX_VERSION}`) {
      throw new SetupError(`Use Codex CLI ${CODEX_VERSION}; other versions have not been verified by this release.`);
    }
    const help = await runLocalCli(config, ['exec', '--help'], env);
    const resume = await runLocalCli(config, ['exec', '--json', 'resume', '--help'], env);
    if (!help.includes('--json') || !help.includes('stdin') || !resume.includes('SESSION_ID')) throw new SetupError('Configured CLI lacks the required noninteractive interfaces.');
    const existing: unknown = await listMcp(config, false, env);
    if (!Array.isArray(existing) || existing.some(server => server?.name === MCP_NAME)) throw new SetupError(`The MCP name ${MCP_NAME} is reserved for Bridge; rename an existing entry before starting.`);
    const merged: unknown = await listMcp(config, true, env);
    if (!Array.isArray(merged) || !merged.some(server => server?.name === MCP_NAME && server.enabled === true)
        || existing.some(server => !merged.some(item => item.name === server.name && isDeepStrictEqual(item, server)))) {
      throw new SetupError('CLI did not preserve existing MCP configuration while adding Bridge.');
    }
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError('Codex CLI probe failed. Check executable, preset and normal Codex configuration; no model turn was run.');
  }
}

export interface ModelRequest {
  project: string;
  prompt: string;
  threadId?: string;
  signal: AbortSignal;
  onThread(id: string): void;
  sendMessage: SendMessage;
}
export interface Model { run(request: ModelRequest): Promise<string> }

export class CodexModel implements Model {
  constructor(private config: Config, private env = process.env) {}

  async run(request: ModelRequest): Promise<string> {
    request.signal.throwIfAborted();
    const sender = await openSender(request.sendMessage);
    try {
      const args = [...this.config.codex.args, ...mcpOverrides(this.config.codex.sendToolApprovalMode), 'exec', '--json'];
      if (request.threadId) args.push('resume', request.threadId);
      args.push('-');
      const context = `This request arrived through Slack Bridge. Bridge forwards message text only; Slack attachment contents are not supplied. If the task depends on an attachment, ask for a description rather than assuming you have seen it. Use the ${MCP_NAME} MCP send_message tool for replies. Format tool messages and final answers using Slack mrkdwn: *bold* for short headings and key names, blank lines between sections, and short bullet lists. Use <https://example.com|descriptive label> for web links, or bare HTTP/HTTPS URLs. Do not use Markdown heading hashes, **bold**, Markdown links, tables or escaped line breaks. Mentions and link previews are disabled. Destination defaults to the originating thread (thread); configured channel aliases: ${Object.keys(this.config.outgoingChannels).join(', ') || '(none)'}. After any tool send, Bridge does not repeat your final answer. If you do not send through the tool, Bridge posts your final answer in the originating thread. Never retry an uncertain delivery.\n\nSlack message:\n`;
      let started = false;
      let completed = false;
      let final = '';
      await invoke(this.config, args, context + request.prompt, { ...childEnvironment(this.env), ...sender.env }, request.signal, line => {
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new ModelFailure('invalid_result');
        if (event.type === 'thread.started') {
          if (started || typeof event.thread_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(event.thread_id)
              || (request.threadId && event.thread_id !== request.threadId)) throw new ModelFailure('invalid_result');
          request.onThread(event.thread_id);
          started = true;
        } else if (event.type === 'error' || event.type === 'turn.failed') {
          throw new ModelFailure('model_failed');
        } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          if (!started || completed || typeof event.item.text !== 'string' || event.item.text.length > 1_000_000) throw new ModelFailure('invalid_result');
          final = event.item.text;
        } else if (event.type === 'turn.completed') {
          if (!started || completed || !event.usage || !['input_tokens', 'cached_input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(event.usage[key]) && event.usage[key] >= 0)) throw new ModelFailure('invalid_result');
          completed = true;
        }
      }, 16_000_000);
      if (!completed) throw new ModelFailure('invalid_result');
      return final;
    } finally { await sender.close(); }
  }
}
