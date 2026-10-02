import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { childEnvironment, ModelFailure, slackContext, type Model, type ModelRequest } from './codex.js';
import type { Config } from './config.js';
import type { Interaction } from './interaction.js';
import { mcpOverrides, openSender } from './mcp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

type Json = Record<string, any>;
type Id = string | number;
function object(value: unknown): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value); }

/** Version-pinned Codex JSON-RPC stdio connection. No shell, policy decisions or retries. */
export class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private requests = new Map<string, { resolve(value: Json): void; reject(error: Error): void }>();
  private bytes = 0;
  private buffer = '';
  private failure?: ModelFailure;
  private closing = false;
  private exited = false;
  private killTimer?: NodeJS.Timeout;
  private closed: Promise<void>;
  private abort: () => void;
  onNotification: (method: string, params: Json) => void = () => {};
  onRequest: (id: Id, method: string, params: Json) => void = () => {};
  onFailure: (error: ModelFailure) => void = () => {};

  constructor(config: Config, env: Record<string, string>, private signal: AbortSignal) {
    signal.throwIfAborted();
    this.child = spawn(config.codex.executable, [...config.codex.args, ...mcpOverrides(config.codex.sendToolApprovalMode), 'app-server'],
      { cwd: config.codex.cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.abort = () => this.fail(new ModelFailure('model_failed'));
    signal.addEventListener('abort', this.abort, { once: true });
    this.child.stdin.on('error', () => { if (!this.closing) this.fail(new ModelFailure('model_failed')); });
    this.child.on('error', () => this.fail(new ModelFailure('cli_unavailable')));
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (data: string) => {
      if (this.closing || this.failure) return;
      this.bytes += Buffer.byteLength(data);
      this.buffer += data;
      if (this.bytes > 16_000_000 || this.buffer.length > 1_100_000) { this.fail(new ModelFailure('invalid_result')); return; }
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        try { if (line.trim()) this.receive(JSON.parse(line)); }
        catch { this.fail(new ModelFailure('invalid_result')); return; }
      }
    });
    this.closed = new Promise(resolve => this.child.once('close', () => {
      this.exited = true;
      signal.removeEventListener('abort', this.abort);
      if (this.killTimer) clearTimeout(this.killTimer);
      this.kill('SIGKILL'); // The configured CLI owns its MCP descendants.
      if (!this.closing) this.fail(new ModelFailure('model_failed'));
      this.rejectRequests();
      resolve();
    }));
  }

  private receive(message: unknown): void {
    if (!object(message)) throw new ModelFailure('invalid_result');
    if (typeof message.method === 'string') {
      if (!object(message.params)) throw new ModelFailure('invalid_result');
      if (typeof message.id === 'string' || typeof message.id === 'number') this.onRequest(message.id, message.method, message.params);
      else if (message.id === undefined) this.onNotification(message.method, message.params);
      else throw new ModelFailure('invalid_result');
    } else if (typeof message.id === 'string') {
      const pending = this.requests.get(message.id);
      if (!pending) throw new ModelFailure('invalid_result');
      this.requests.delete(message.id);
      if (message.error !== undefined) pending.reject(new ModelFailure('model_failed'));
      else if (object(message.result)) pending.resolve(message.result);
      else pending.reject(new ModelFailure('invalid_result'));
    } else throw new ModelFailure('invalid_result');
  }

  private send(message: unknown): void {
    if (this.failure || this.closing || this.signal.aborted) throw this.failure ?? new ModelFailure('model_failed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: Json): Promise<Json> {
    const id = `bridge-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      try { this.send({ id, method, params }); }
      catch (error) { this.requests.delete(id); reject(error); }
    });
  }
  notify(method: string, params: Json = {}): void { this.send({ method, params }); }
  respond(id: Id, result: unknown): void { this.send({ id, result }); }
  fail(error: ModelFailure): void {
    if (this.failure || this.closing) return;
    this.failure = error;
    this.rejectRequests();
    this.onFailure(error);
    this.stop();
  }
  private rejectRequests(): void {
    for (const pending of this.requests.values()) pending.reject(this.failure ?? new ModelFailure('model_failed'));
    this.requests.clear();
  }
  private kill(signal: NodeJS.Signals): void {
    if (this.child.pid) { try { process.kill(-this.child.pid, signal); } catch { this.child.kill(signal); } }
  }
  private stop(): void {
    if (this.killTimer || this.exited) return;
    this.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.kill('SIGKILL'), 1000);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.rejectRequests();
    this.stop();
    await this.closed;
  }
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'techbase_bridge', title: 'Techbase Bridge', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    this.notify('initialized');
  }
}

function approval(text: string, accepted: unknown, declined: unknown): Interaction {
  return { text, instructions: 'Reply `approve` or `deny` in this thread. With several pending prompts, use `approve ID` or `deny ID`. This grants only the scope shown above.',
    parse: action => action === 'approve' ? accepted : action === 'deny' ? declined : undefined };
}

async function interact(request: ModelRequest, prompt: Interaction, signal: AbortSignal): Promise<unknown> {
  if (!request.interact) throw new ModelFailure('interaction_required');
  return request.interact(prompt, signal);
}

async function nativePrompt(method: string, params: Json, item: Json | undefined, request: ModelRequest, signal: AbortSignal): Promise<unknown> {
  if (method === 'item/commandExecution/requestApproval') {
    const details = { kind: params.kind, reason: params.reason, command: params.command ?? item?.command, cwd: params.cwd ?? item?.cwd,
      network: params.networkApprovalContext, additionalPermissions: params.additionalPermissions };
    if (!details.command && !details.network) throw new ModelFailure('invalid_result');
    return interact(request, approval('*Codex requests approval*\n' + JSON.stringify(details, null, 2), { decision: 'accept' }, { decision: 'decline' }), signal);
  }
  if (method === 'item/fileChange/requestApproval') {
    // File approval may cover a session-wide root; show its native scope explicitly.
    const details = { reason: params.reason, grantRoot: params.grantRoot, changes: item?.changes };
    if (!item?.changes && !params.grantRoot) throw new ModelFailure('invalid_result');
    return interact(request, approval('*Codex requests file approval*\n' + JSON.stringify(details, null, 2), { decision: 'accept' }, { decision: 'decline' }), signal);
  }
  if (method === 'item/permissions/requestApproval') {
    if (!object(params.permissions)) throw new ModelFailure('invalid_result');
    const permissions = Object.fromEntries(Object.entries(params.permissions).filter(([, value]) => value !== null));
    return interact(request, approval('*Codex requests permissions for this turn*\n' + JSON.stringify({ reason: params.reason, cwd: params.cwd, permissions }, null, 2),
      { permissions, scope: 'turn' }, { permissions: {}, scope: 'turn' }), signal);
  }
  if (method === 'item/tool/requestUserInput') {
    if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 3) throw new ModelFailure('invalid_result');
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of params.questions) {
      if (!object(question) || typeof question.id !== 'string' || typeof question.question !== 'string') throw new ModelFailure('invalid_result');
      if (question.isSecret) throw new ModelFailure('unsupported_interaction'); // Never ask for credentials in Slack.
      const options = Array.isArray(question.options) ? question.options : [];
      const labels = options.map(option => { if (!object(option) || typeof option.label !== 'string') throw new ModelFailure('invalid_result'); return option.label; });
      const response = await interact(request, { text: '*Codex asks*\n' + question.question + (options.length ? '\n\n' + options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ': ' + o.description : ''}`).join('\n') : ''),
        instructions: 'Reply with your answer (or an option number) in this thread. With several pending prompts, use `answer ID your answer`.',
        parse: (action, text) => {
          if (action === 'deny') return { answers: [] };
          if (action !== 'answer' || !text.trim()) return;
          const index = /^\d+$/.test(text.trim()) ? Number(text.trim()) - 1 : -1;
          const selected = labels[index] ?? text;
          if (labels.length && !question.isOther && !labels.includes(selected)) return;
          return { answers: [selected] };
        } }, signal);
      answers[question.id] = response as { answers: string[] };
    }
    return { answers };
  }
  if (method === 'mcpServer/elicitation/request') {
    const declined = { action: 'decline', content: null, _meta: null };
    if (params.mode === 'url') return interact(request, approval(`*${params.serverName} requests confirmation*\n${params.message}\n${params.url}\nComplete the linked flow before approving.`,
      { action: 'accept', content: null, _meta: null }, declined), signal);
    if (['form', 'openai/form', 'openaiForm'].includes(params.mode) && object(params.requestedSchema)) {
      const validate = new AjvJsonSchemaValidator().getValidator(params.requestedSchema);
      return interact(request, { text: `*${params.serverName} requests input*\n${params.message}\n\nRequested JSON fields:\n${JSON.stringify(params.requestedSchema, null, 2)}`,
        instructions: 'Reply with the requested JSON object, or `deny`, in this thread. With several pending prompts, use `answer ID {"field":"value"}` or `deny ID`. Keep credentials out of Slack.',
        parse: (action, text) => {
          if (action === 'deny') return declined;
          if (action !== 'answer') return;
          try { const content = JSON.parse(text); if (object(content) && validate(content).valid) return { action: 'accept', content, _meta: null }; } catch {}
          return;
        } }, signal);
    }
  }
  throw new ModelFailure('unsupported_interaction');
}

/** Native thread/turn API, including server-initiated approvals and user input. */
export class AppServerModel implements Model {
  constructor(private config: Config, private env = process.env) {}

  async run(request: ModelRequest): Promise<string> {
    const sender = await openSender(request.sendMessage);
    let client: AppServer | undefined;
    const pending = new Map<Id, AbortController>();
    const items = new Map<string, Json>();
    let threadId = '';
    let turnId = '';
    let final = '';
    let complete = false;
    let resolveTurn!: () => void;
    let rejectTurn!: (error: Error) => void;
    const ended = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    void ended.catch(() => {}); // A startup failure can precede the turn await.
    try {
      client = new AppServer(this.config, { ...childEnvironment(this.env), ...sender.env }, request.signal);
      const rpc = client;
      rpc.onFailure = rejectTurn;
      rpc.onNotification = (method, params) => {
        if (method === 'serverRequest/resolved' && params.threadId === threadId) {
          pending.get(params.requestId)?.abort(); pending.delete(params.requestId); return;
        }
        if (params.threadId !== threadId || !threadId) return;
        if (method === 'turn/started') {
          if (!identifier(params.turn?.id) || (turnId && turnId !== params.turn.id)) throw new ModelFailure('invalid_result');
          turnId = params.turn.id;
        } else if (method === 'item/started' || method === 'item/completed') {
          if (params.turnId !== turnId || complete || !object(params.item)) throw new ModelFailure('invalid_result');
          const item = params.item;
          if (method === 'item/started' && ['fileChange', 'commandExecution'].includes(item.type)) items.set(item.id, item);
          if (method === 'item/completed' && item.type === 'agentMessage' && item.phase !== 'commentary') {
            if (typeof item.text !== 'string' || item.text.length > 1_000_000) throw new ModelFailure('invalid_result');
            final = item.text;
          }
          if (method === 'item/completed') items.delete(item.id);
        } else if (method === 'turn/completed') {
          if (complete || params.turn?.id !== turnId) throw new ModelFailure('invalid_result');
          complete = true;
          if (params.turn.status === 'completed') resolveTurn(); else rejectTurn(new ModelFailure('model_failed'));
        }
      };
      rpc.onRequest = (id, method, params) => {
        if (complete || !threadId || params.threadId !== threadId || (params.turnId !== null && params.turnId !== turnId) || pending.has(id)) {
          rpc.fail(new ModelFailure('invalid_result')); return;
        }
        const controller = new AbortController(); pending.set(id, controller);
        const signal = AbortSignal.any([request.signal, controller.signal]);
        void nativePrompt(method, params, items.get(params.itemId), request, signal).then(result => {
          if (!signal.aborted && !complete) rpc.respond(id, result);
        }).catch(error => {
          if (!signal.aborted) rpc.fail(error instanceof ModelFailure ? error : new ModelFailure('model_failed'));
        }).finally(() => { if (pending.get(id) === controller) pending.delete(id); });
      };
      await rpc.initialize();
      // Passing effective config also replaces stale exec-session permission settings on resume.
      const settings = await rpc.request('config/read', { cwd: this.config.codex.cwd, includeLayers: false });
      const params: Json = { cwd: this.config.codex.cwd };
      if (settings.config?.approval_policy !== undefined) params.approvalPolicy = settings.config.approval_policy;
      if (settings.config?.approvals_reviewer !== undefined) params.approvalsReviewer = settings.config.approvals_reviewer;
      if (settings.config?.sandbox_mode !== undefined) params.sandbox = settings.config.sandbox_mode;
      if (request.threadId) { params.threadId = request.threadId; params.excludeTurns = true; }
      const session = await rpc.request(request.threadId ? 'thread/resume' : 'thread/start', params);
      if (!identifier(session.thread?.id) || (request.threadId && session.thread.id !== request.threadId)) throw new ModelFailure('invalid_result');
      threadId = session.thread.id;
      request.onThread(threadId);
      const turn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: slackContext(this.config) + request.prompt }] });
      if (!identifier(turn.turn?.id) || (turnId && turnId !== turn.turn.id)) throw new ModelFailure('invalid_result');
      turnId = turn.turn.id;
      await ended;
      return final;
    } finally {
      for (const controller of pending.values()) controller.abort();
      await client?.close();
      await sender.close();
    }
  }
}
