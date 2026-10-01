import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { parseConfig, type Config } from '../src/config.js';
import type { Clock } from '../src/bridge.js';
import type { Model, ModelRequest } from '../src/codex.js';
import type { SlackPost, SlackSender } from '../src/output.js';

export function fixture(t: TestContext, overrides: Partial<Config> = {}): { root: string; config: Config; project2: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bridge-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['state', 'codex', 'project', 'project2']) mkdirSync(path.join(root, directory), { mode: 0o700 });
  for (const directory of ['project', 'project2']) mkdirSync(path.join(root, directory, '.git'));
  const project2 = path.join(root, 'project2');
  const config = parseConfig({ teamId: 'TEXAMPLE', botUserId: 'UBRIDGE', allowedUserIds: ['UALICE', 'UBOB', 'UOPERATOR'], operatorUserIds: ['UOPERATOR'],
    channels: { CPROJECT: path.join(root, 'project'), CSECOND: project2, CALIAS: path.join(root, 'project') },
    stateDir: path.join(root, 'state'), codexHome: path.join(root, 'codex'), hostPolicyReviewed: true,
    ...overrides });
  return { root, config, project2 };
}

export const NOW = 1_800_000_000_000;
export function mention(id: string, text = 'Explain the code', event: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  return { type: 'event_callback', team_id: 'TEXAMPLE', api_app_id: 'AEXAMPLE', event_id: id, event_time: NOW / 1000,
    authorizations: [{ team_id: 'TEXAMPLE', user_id: 'UBRIDGE', is_bot: true }],
    event: { type: 'app_mention', user: 'UALICE', channel: 'CPROJECT', ts: '1800000000.000001', text: `<@UBRIDGE> ${text}`, ...event }, ...body };
}

export class ManualClock implements Clock {
  time = NOW;
  timers = new Set<{ at: number; callback(): void }>();
  now() { return this.time; }
  timer(callback: () => void, ms: number) {
    const entry = { at: this.time + ms, callback };
    this.timers.add(entry);
    return () => this.timers.delete(entry);
  }
  advance(ms: number) {
    this.time += ms;
    for (const entry of [...this.timers]) {
      if (entry.at <= this.time) { this.timers.delete(entry); entry.callback(); }
    }
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class ControlledModel implements Model {
  calls: { request: ModelRequest; result: ReturnType<typeof deferred<string>> }[] = [];
  private change = deferred();
  async run(request: ModelRequest): Promise<string> {
    const result = deferred<string>();
    const call = { request, result };
    this.calls.push(call);
    request.onThread(request.threadId ?? `fixture-thread-${this.calls.length}`);
    const abort = () => result.reject(new Error('fixture provider secret payload'));
    request.signal.addEventListener('abort', abort, { once: true });
    this.change.resolve();
    this.change = deferred();
    try { return await result.promise; }
    finally { request.signal.removeEventListener('abort', abort); }
  }
  async started(count: number) {
    while (this.calls.length < count) await this.change.promise;
    return this.calls[count - 1]!;
  }
}

export class RecordingSlack implements SlackSender {
  posts: SlackPost[] = [];
  failOn = 0;
  async post(message: SlackPost): Promise<void> {
    this.posts.push(message);
    if (this.posts.length === this.failOn) throw new Error('fixture token and provider payload');
  }
}
