import { App, LogLevel, type AppOptions, type Logger } from '@slack/bolt';
import type { Bridge, Diagnostic } from './bridge.js';
import { incomingChannelAllowed, SetupError, type Config } from './config.js';
import type { SlackSender } from './output.js';
import type { ParentReader } from './parent-context.js';

export function safeLogger(diagnostic: Diagnostic): Logger {
  // SDK log arguments can contain provider payloads, prompts and credentials.
  return { debug() {}, info() {}, warn() { diagnostic('slack_sdk_warning'); }, error() { diagnostic('slack_sdk_error'); },
    setLevel() {}, setName() {}, getLevel() { return LogLevel.ERROR; } };
}

export function appOptions(botToken: string, appToken: string, diagnostic: Diagnostic): AppOptions {
  return {
    token: botToken, appToken, socketMode: true, convoStore: false,
    deferInitialization: true, tokenVerificationEnabled: false,
    logger: safeLogger(diagnostic),
    clientOptions: {
      // A network error can follow acceptance by Slack. Do not silently resend.
      retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
      timeout: 10_000, maxRequestConcurrency: 2, allowAbsoluteUrls: false,
    },
  };
}

export function wireSlack(app: App, bridge: Bridge, diagnostic: Diagnostic): void {
  app.event('message', async ({ body }) => { await bridge.accept(body); });
  app.error(async () => { diagnostic('slack_event_failed'); });
}

export function slackSender(app: App): SlackSender {
  return { async post(message) {
    const result = await app.client.chat.postMessage(message);
    if (!result.ok || typeof result.ts !== 'string') throw new Error('slack_delivery_uncertain');
  } };
}

export async function verifySlackIdentity(app: App, config: Config): Promise<void> {
  const identity = await app.client.auth.test();
  if (!identity.ok || identity.team_id !== config.teamId || identity.user_id !== config.botUserId) {
    throw new SetupError('Slack token identity does not match the configured team and bot.');
  }
}

/** Only this bot's exact parent in an already authorized incoming channel. */
export function slackParentReader(app: App, config: Config): ParentReader {
  return async (scope, replyTs, signal) => {
    const timestamp = /^\d{1,16}\.\d{6}$/;
    if (scope.team !== config.teamId || !incomingChannelAllowed(config, scope.channel)
        || !timestamp.test(scope.root) || !timestamp.test(replyTs) || scope.root === replyTs) return;
    const base = { parentTs: scope.root, replyTs };
    try {
      signal.throwIfAborted();
      // This SDK has a bounded HTTP timeout; racing cancellation prevents a
      // cancelled read from starting a model turn even while HTTP settles.
      const pending = app.client.conversations.history({
        channel: scope.channel, oldest: scope.root, latest: scope.root, inclusive: true, limit: 1,
      });
      const result = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        void pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
          error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      if (!result.ok) return { ...base, status: 'unavailable' };
      const parent = result.messages?.find(message => message.ts === scope.root);
      if (!parent) return { ...base, status: 'unavailable' };
      if (parent.user !== config.botUserId) return;
      if (typeof parent.text !== 'string' || !parent.text.trim()) return { ...base, status: 'unavailable' };
      const edited = parent.edited?.ts;
      if (edited !== undefined && !timestamp.test(edited)) return { ...base, status: 'unavailable' };
      const micros = (value: string) => { const [seconds, fraction] = value.split('.'); return BigInt(seconds!) * 1_000_000n + BigInt(fraction!); };
      const changed = edited !== undefined && micros(edited) > micros(replyTs);
      const limit = Math.min(6000, config.maxInputChars);
      const text = parent.text.slice(0, limit).replace(/[\ud800-\udbff]$/, '');
      return { ...base, status: changed ? 'changed_after_reply' : 'available', text,
        truncated: text.length < parent.text.length, hasAttachments: !!parent.files?.length || !!parent.attachments?.length };
    } catch {
      signal.throwIfAborted();
      return { ...base, status: 'unavailable' };
    }
  };
}
