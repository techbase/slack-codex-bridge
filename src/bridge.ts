import { ModelFailure, type Model } from './codex.js';
import type { Config } from './config.js';
import { sendText, type SlackSender } from './output.js';
import { Store, type Job, type Scope } from './store.js';
import { TurnSender } from './send.js';
import { randomBytes } from 'node:crypto';
import type { Interaction } from './interaction.js';

export interface Clock {
  now(): number;
  timer(callback: () => void, ms: number): () => void;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  timer(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
};
export type Diagnostic = (reason: string, jobId?: string) => void;
type Routed = Scope & { user: string; eventId: string; prompt: string; hasFiles: boolean };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function route(config: Config, value: unknown, now: number): Routed | undefined {
  const body = object(value);
  const event = object(body?.event);
  const hasFiles = event?.subtype === 'file_share' || (Array.isArray(event?.files) && event.files.length > 0);
  const text = event?.text === undefined && hasFiles ? '' : event?.text;
  if (!body || !event || body.type !== 'event_callback' || body.team_id !== config.teamId
      || event.type !== 'message' || (event.subtype !== undefined && event.subtype !== 'file_share') || event.bot_id !== undefined
      || event.bot_profile !== undefined || event.hidden === true || event.edited !== undefined
      || (event.team !== undefined && event.team !== config.teamId)
      || (event.user_team !== undefined && event.user_team !== config.teamId)
      || body.is_ext_shared_channel === true || event.is_ext_shared_channel === true
      || typeof event.user !== 'string' || event.user === config.botUserId || !config.allowedUserIds.includes(event.user)
      || typeof event.channel !== 'string' || !config.incomingChannelIds.includes(event.channel)
      || typeof body.event_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.event_id)
      || typeof body.event_time !== 'number' || !Number.isSafeInteger(body.event_time)
      || body.event_time * 1000 < now - config.retentionMs || body.event_time * 1000 > now + 300_000
      || typeof event.ts !== 'string' || !/^\d{1,16}\.\d{6}$/.test(event.ts)
      || (event.thread_ts !== undefined && (typeof event.thread_ts !== 'string' || !/^\d{1,16}\.\d{6}$/.test(event.thread_ts)))
      || typeof text !== 'string' || (config.mentionOnly && !text.includes(`<@${config.botUserId}>`))) return;
  const prompt = text.replaceAll(`<@${config.botUserId}>`, '').trim();
  return { team: config.teamId, channel: event.channel, root: (event.thread_ts as string | undefined) ?? event.ts,
    project: config.codex.cwd, user: event.user, eventId: body.event_id, prompt, hasFiles };
}

const HELP = 'Send a message to start or continue a Codex CLI conversation in this thread (mention Bridge if mention-only mode is configured). Codex uses the operator’s existing permissions and preset. Use help, status, or cancel. In app-server mode, reply to native prompts with approve ID, deny ID, or answer ID your answer. Only the requester or a configured operator may answer prompts or cancel a request.';

export class Bridge {
  private closing = false;
  private active = new Map<string, { job: Job; controller: AbortController; done: Promise<void>; reason?: 'cancelled' | 'timed_out' | 'interrupted' }>();
  private handlers = new Set<Promise<void>>();
  private background = new Set<Promise<void>>();
  private stopMaintenance?: () => void;
  private shutdownTask?: Promise<void>;
  private interactions = new Map<string, { job: Job; prompt: Interaction; signal: AbortSignal; resolve(value: unknown): void }>();

  constructor(
    private config: Config,
    readonly store: Store,
    private model: Model,
    private sender: SlackSender,
    private secrets: string[],
    private diagnostic: Diagnostic = () => {},
    private clock: Clock = systemClock,
    private onFatal: () => void = () => {},
  ) {}

  start(): void { this.maintain(); }

  accept(body: unknown): Promise<void> {
    if (this.closing) return Promise.resolve();
    const task = this.handle(body).catch(() => { this.fail('event_handling_failed'); });
    this.handlers.add(task);
    void task.finally(() => this.handlers.delete(task));
    return task;
  }

  private async handle(body: unknown): Promise<void> {
    const routed = route(this.config, body, this.clock.now());
    if (!routed) return;
    this.store.cleanup(this.clock.now());
    const claim = this.store.claimEvent(routed.eventId, this.clock.now());
    if (claim !== 'new') { if (claim === 'full') this.diagnostic('event_capacity'); return; }
    const command = routed.prompt.toLowerCase();
    if (command === '' && routed.hasFiles) {
      await this.reply(routed, 'This message contains an attachment, but Bridge currently forwards text only. Describe what you want Codex to do in a message. Nothing was queued.');
      return;
    }
    if (command === 'help' || command === '') { await this.reply(routed, HELP); return; }
    if (command === 'status') { await this.reply(routed, this.status(routed)); return; }
    if (command === 'cancel') { await this.cancel(routed); return; }
    if (/^(approve|deny|answer)\s+[a-f0-9]{24}(\s|$)/i.test(routed.prompt)) { await this.answerInteraction(routed); return; }
    const prompts = [...this.interactions.entries()].filter(([, p]) => !p.signal.aborted && p.job.team === routed.team
      && p.job.channel === routed.channel && p.job.root === routed.root && p.job.project === routed.project);
    if (prompts.length === 1) {
      const action = command === 'approve' || command === 'deny' ? command : 'answer';
      await this.answerInteraction({ ...routed, prompt: `${action} ${prompts[0]![0]}${action === 'answer' ? ' ' + routed.prompt : ''}` });
      return;
    }
    if (prompts.length > 1) { await this.reply(routed, 'Several native prompts are waiting in this thread. Include the prompt ID in your response.'); return; }
    if (routed.prompt.length > this.config.maxInputChars) {
      await this.reply(routed, `Request too long. Limit: ${this.config.maxInputChars} characters. Nothing was queued.`);
      return;
    }
    const job = this.store.enqueue(routed, routed.eventId, routed.user, routed.prompt, this.clock.now());
    if (!job) { await this.reply(routed, 'Bridge is busy; the queue is full. Nothing was queued. Please ask again later.'); return; }
    const sent = routed.hasFiles
      ? await this.reply(job, 'Attachments were not sent to Codex; this request contains text only.')
      : true;
    this.store.acknowledge(job.id, routed.hasFiles ? (sent ? 'sent' : 'uncertain') : 'skipped');
    if (!sent) {
      // A concurrent cancel command may already have terminated the queued job.
      if (this.store.job(job.id)?.state === 'queued') {
        this.store.finish(job.id, 'interrupted', 'ack_uncertain', this.clock.now());
        this.store.delivery(job.id, 'uncertain');
      }
      return;
    }
    if (this.closing) return;
    this.pump();
  }

  private status(scope: Scope): string {
    const pending = this.store.inScope(scope);
    const job = pending.find(job => job.state === 'active') ?? pending[0] ?? this.store.latest(scope);
    if (!job) return 'No requests are recorded in this thread.';
    const delivery = job.delivery === 'uncertain' ? ' Slack outcome delivery is uncertain; the turn will not be replayed. Ask again explicitly if needed.'
      : job.delivery === 'sent' ? ' Outcome delivered.' : '';
    const recovery = job.state === 'interrupted' ? ' Interrupted requests are never replayed automatically.' : '';
    const waiting = [...this.interactions.entries()].filter(([, p]) => p.job.id === job.id && !p.signal.aborted).map(([id]) => id);
    return `Request ${job.id}: ${job.state}.${waiting.length ? ` Waiting for your response to prompt(s): ${waiting.join(', ')}.` : ''}${delivery}${recovery}${pending.length > 1 ? ` ${pending.length} requests remain in this thread.` : ''}`;
  }

  private async answerInteraction(scope: Routed): Promise<void> {
    const match = /^(approve|deny|answer)\s+([a-f0-9]{24})(?:\s+([\s\S]*))?$/i.exec(scope.prompt);
    const pending = match && this.interactions.get(match[2]!.toLowerCase());
    if (!pending || pending.signal.aborted || pending.job.team !== scope.team || pending.job.channel !== scope.channel
        || pending.job.root !== scope.root || pending.job.project !== scope.project) {
      await this.reply(scope, 'No matching live prompt in this thread. Nothing was approved or queued. Use status to check the request.'); return;
    }
    if (scope.user !== pending.job.user && !this.config.operatorUserIds.includes(scope.user)) {
      await this.reply(scope, 'Only the requester or a configured operator may answer this prompt.'); return;
    }
    if ((match![1]!.toLowerCase() !== 'answer' && match![3]?.trim()) || scope.prompt.length > this.config.maxInputChars) {
      await this.reply(scope, 'Invalid prompt response. ' + pending.prompt.instructions.replaceAll(/\bID\b/g, match![2]!)); return;
    }
    const answer = pending.prompt.parse(match![1]!.toLowerCase() as 'approve' | 'deny' | 'answer', match![3] ?? '');
    if (answer === undefined) {
      await this.reply(scope, 'Invalid prompt response. ' + pending.prompt.instructions.replaceAll(/\bID\b/g, match![2]!)); return;
    }
    // Consume before awaiting Slack. Duplicate or concurrent events cannot approve twice.
    this.interactions.delete(match![2]!);
    pending.resolve(answer);
    await this.reply(scope, `Response submitted to Codex for prompt ${match![2]}. Use status to check the turn.`);
  }

  private interaction(job: Job, prompt: Interaction, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal.aborted || this.closing) { reject(new ModelFailure('model_failed')); return; }
      const id = randomBytes(12).toString('hex');
      const clear = () => { signal.removeEventListener('abort', abort); this.interactions.delete(id); };
      const abort = () => { clear(); reject(new ModelFailure('model_failed')); };
      this.interactions.set(id, { job, prompt, signal, resolve: answer => { clear(); resolve(answer); } });
      signal.addEventListener('abort', abort, { once: true });
      this.track(this.reply(job, `${prompt.text}\n\n${prompt.instructions.replaceAll(/\bID\b/g, id)}\nPrompt: ${id}`, job.id).then(sent => {
        if (!sent && this.interactions.has(id)) { this.store.delivery(job.id, 'uncertain'); clear(); reject(new ModelFailure('interaction_required')); }
      }).catch(() => { clear(); reject(new ModelFailure('model_failed')); }));
    });
  }

  private async cancel(scope: Routed): Promise<void> {
    const jobs = this.store.inScope(scope);
    const eligible = jobs.filter(job => job.user === scope.user || this.config.operatorUserIds.includes(scope.user));
    if (!eligible.length) {
      await this.reply(scope, jobs.length ? 'Only the requester or a configured operator may cancel these requests.' : 'No queued or active requests to cancel in this thread.');
      return;
    }
    const queuedIds: string[] = [];
    for (const job of eligible) {
      const active = this.active.get(job.project);
      if (active?.job.id === job.id) {
        active.reason ??= 'cancelled';
        active.controller.abort();
      } else {
        queuedIds.push(job.id);
        this.store.finish(job.id, 'cancelled', 'requested', this.clock.now());
        // The command response is the queued request's cancellation outcome.
        this.store.delivery(job.id, 'sending');
      }
    }
    const sent = await this.reply(scope, `Cancellation requested for ${eligible.length} request(s). Active turns must stop before the next turn starts.`);
    for (const id of queuedIds) this.store.delivery(id, sent ? 'sent' : 'uncertain');
    this.pump();
  }

  private pump(): void {
    if (this.closing) return;
    const awaitingNotice = new Set<string>();
    for (const job of this.store.queued()) {
      if (this.clock.now() - job.created >= this.config.queueTtlMs) {
        this.store.finish(job.id, 'interrupted', 'queue_expired', this.clock.now());
        this.track(this.deliver(job, 'Request expired while queued. Nothing ran; send another message to ask.'));
        continue;
      }
      // Preserve arrival order while an attachment notice is being delivered.
      if (job.ack !== 'sent' && job.ack !== 'skipped') awaitingNotice.add(job.project);
      if (awaitingNotice.has(job.project)) continue;
      if (this.active.has(job.project) || this.active.size >= 1) continue;
      this.store.activate(job.id, this.clock.now());
      const active = { job, controller: new AbortController(), done: Promise.resolve() } as { job: Job; controller: AbortController; done: Promise<void>; reason?: 'cancelled' | 'timed_out' | 'interrupted' };
      this.active.set(job.project, active);
      active.done = this.execute(active).catch(() => {
        // Unexpected persistence failures stop admission. Recovery handles any
        // unfinished record; never fabricate success or expose exception payloads.
        this.fail('worker_failed', job.id);
      }).finally(() => {
        this.active.delete(job.project);
        this.pump();
      });
    }
  }

  private async execute(active: { job: Job; controller: AbortController; reason?: 'cancelled' | 'timed_out' | 'interrupted' }): Promise<void> {
    const { job, controller } = active;
    const stopTimeout = this.config.turnTimeoutMs === 0 ? () => {}
      : this.clock.timer(() => { active.reason ??= 'timed_out'; controller.abort(); }, this.config.turnTimeoutMs);
    let answer = '';
    let failure: string | undefined;
    const turnSender = new TurnSender(this.config, job, this.store, this.sender, this.secrets, controller.signal);
    try {
      this.store.touchThread(job, this.clock.now());
      answer = await this.model.run({ project: job.project, prompt: job.prompt!, threadId: this.store.thread(job), signal: controller.signal,
        onThread: id => this.store.saveThread(job, id, this.clock.now()), sendMessage: turnSender.send,
        interact: (prompt, signal) => this.interaction(job, prompt, signal) });
      if (!turnSender.attempted && (typeof answer !== 'string' || !answer.trim())) failure = 'invalid_result';
    } catch (error) {
      failure = error instanceof ModelFailure ? error.reason : 'model_failed';
    } finally { await turnSender.settled(); stopTimeout(); }
    const state = active.reason ?? (failure ? 'failed' : 'completed');
    this.store.finish(job.id, state, failure ?? active.reason ?? null, this.clock.now());
    this.store.touchThread(job, this.clock.now());
    if (failure && !active.reason) this.diagnostic(failure, job.id);
    const output = state === 'completed' ? `Completed request ${job.id}.\n\n${answer}`
      : state === 'cancelled' ? `Request ${job.id} cancelled. No automatic retry.`
      : state === 'timed_out' ? `Request ${job.id} timed out and was stopped. Send another message to retry explicitly.`
      : state === 'interrupted' ? `Request ${job.id} interrupted by shutdown. It will not be replayed.`
      : `Request ${job.id} failed (${failure}). Codex did not finish this turn. An operator can check the safe diagnostic ID; no automatic retry.`;
    // Suppress duplicate successful answers, but an earlier progress send must
    // not hide a later failure, timeout, cancellation or shutdown.
    if (!turnSender.attempted || state !== 'completed') {
      const partial = turnSender.attempted ? '\n\nEarlier messages may describe unfinished work. Check actual results before retrying.' : '';
      await this.deliver(job, output + partial);
    }
  }

  private async deliver(job: Job, text: string): Promise<void> {
    const priorUncertainty = this.store.job(job.id)?.delivery === 'uncertain';
    this.store.delivery(job.id, priorUncertainty ? 'uncertain' : 'sending');
    const sent = await this.reply(job, text, job.id);
    this.store.delivery(job.id, sent && !priorUncertainty ? 'sent' : 'uncertain');
  }

  private async reply(scope: Scope, text: string, jobId?: string): Promise<boolean> {
    try {
      const sender: SlackSender = { post: async message => {
        if (scope.team !== this.config.teamId || !this.config.incomingChannelIds.includes(message.channel)
            || message.channel !== scope.channel || message.thread_ts !== scope.root) throw new Error('unauthorized_destination');
        await this.sender.post(message);
      } };
      await sendText(sender, scope.channel, scope.root, text, this.secrets, this.config.maxOutputChars);
      return true;
    } catch {
      this.diagnostic('slack_delivery_uncertain', jobId);
      return false;
    }
  }

  private track(task: Promise<void>): void {
    const guarded = task.catch(() => { this.fail('maintenance_failed'); });
    this.background.add(guarded);
    void guarded.finally(() => this.background.delete(guarded));
  }

  private maintain(): void {
    if (this.closing) return;
    try {
      this.store.cleanup(this.clock.now());
      this.pump();
      this.stopMaintenance = this.clock.timer(() => this.maintain(), Math.min(60_000, this.config.queueTtlMs));
    } catch { this.fail('maintenance_failed'); }
  }

  private fail(reason: string, jobId?: string): void {
    const wasClosing = this.closing;
    this.closing = true;
    this.stopMaintenance?.();
    for (const active of this.active.values()) { active.reason ??= 'interrupted'; active.controller.abort(); }
    this.diagnostic(reason, jobId);
    if (!wasClosing) this.onFatal();
  }

  /** Useful to owners/tests: waits for admitted work, including queued work. */
  async idle(): Promise<void> {
    do {
      await Promise.all([...this.handlers, ...this.background, ...[...this.active.values()].map(active => active.done)]);
    } while (this.handlers.size || this.background.size || this.active.size);
  }

  shutdown(): Promise<void> {
    return this.shutdownTask ??= this.stop();
  }

  private async stop(): Promise<void> {
    this.closing = true;
    this.stopMaintenance?.();
    for (const active of this.active.values()) { active.reason ??= 'interrupted'; active.controller.abort(); }
    await Promise.all([...this.handlers]);
    try {
      for (const job of this.store.unfinished()) {
        if (job.state === 'queued') {
          this.store.finish(job.id, 'interrupted', 'shutdown', this.clock.now());
          await this.deliver(job, `Request ${job.id} interrupted by shutdown before execution. It will not be replayed.`);
        }
      }
    } finally { await this.idle(); }
  }
}
