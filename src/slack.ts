import { App, LogLevel, type AppOptions, type Logger } from '@slack/bolt';
import type { Bridge, Diagnostic } from './bridge.js';
import { SetupError, type Config } from './config.js';
import type { SlackSender } from './output.js';

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
