import type { Config } from './config.js';
import { sendText, slackChunks, type SlackSender } from './output.js';
import type { Job, Store } from './store.js';

export type SendResult = { ok: boolean; message: string };
export type SendMessage = (input: unknown) => Promise<SendResult>;

/** A turn-scoped sender. Authorization happens here, beyond the MCP schema. */
export class TurnSender {
  attempted = false;
  private busy = false;
  private uncertain = false;
  private usedChars = 0;
  private calls = 0;
  private pending?: Promise<SendResult>;

  constructor(private config: Config, private job: Job, private store: Store,
    private slack: SlackSender, private secrets: string[], private signal: AbortSignal) {}

  send: SendMessage = async input => {
    if (this.signal.aborted) return { ok: false, message: 'Request stopped; nothing sent.' };
    if (this.uncertain) return { ok: false, message: 'Previous delivery is uncertain. Further sends are disabled; do not retry.' };
    if (this.busy) return { ok: false, message: 'A send is already in progress; wait for its result.' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Invalid send_message arguments; nothing sent.' };
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some(key => !['text', 'destination'].includes(key)) || typeof raw.text !== 'string' || !raw.text.trim()
        || (raw.destination !== undefined && typeof raw.destination !== 'string')) return { ok: false, message: 'Use text and an optional configured destination alias only; nothing sent.' };
    const destination = raw.destination ?? 'thread';
    const channel = destination === 'thread' ? this.job.channel
      : Object.hasOwn(this.config.outgoingChannels, destination) ? this.config.outgoingChannels[destination] : undefined;
    if (this.job.team !== this.config.teamId || !this.config.incomingChannelIds.includes(this.job.channel) || !channel) {
      return { ok: false, message: 'Destination is not allowed; nothing sent.' };
    }
    if (++this.calls > 10 || raw.text.length > this.config.maxOutputChars - this.usedChars) return { ok: false, message: 'Turn output limit reached; nothing sent.' };
    if (!slackChunks(raw.text, this.secrets, this.config.maxOutputChars).join('').trim()) return { ok: false, message: 'Message contains no visible text; nothing sent.' };
    this.usedChars += raw.text.length;
    this.busy = true;
    this.attempted = true;
    const task = this.deliver(channel, destination === 'thread' ? this.job.root : undefined, raw.text);
    this.pending = task;
    try { return await task; }
    finally { this.busy = false; }
  };

  private async deliver(channel: string, thread: string | undefined, text: string): Promise<SendResult> {
    // Persist intent before the first API call. Restart never replays it.
    this.store.delivery(this.job.id, 'sending');
    // Finish before the MCP tool deadline even with many slow Slack chunks.
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]);
    try {
      const guarded: SlackSender = { post: async message => {
        // Recheck the destination and cancellation before every chunk/API call.
        if (signal.aborted || this.job.team !== this.config.teamId
            || !(message.channel === this.job.channel && message.thread_ts === this.job.root
              || Object.values(this.config.outgoingChannels).includes(message.channel))) throw new Error('send_stopped');
        await this.slack.post(message);
      } };
      await sendText(guarded, channel, thread, text, this.secrets, this.config.maxOutputChars);
      this.store.delivery(this.job.id, 'sent');
      return { ok: true, message: 'Message sent. Bridge will not repeat the final answer automatically.' };
    } catch {
      this.uncertain = true;
      this.store.delivery(this.job.id, 'uncertain');
      return { ok: false, message: 'Delivery is uncertain and may have succeeded. Do not retry; further sends are disabled.' };
    }
  }

  async settled(): Promise<void> { await this.pending; }
}
