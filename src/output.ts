export const MESSAGE_CHARS = 3000;

/** Redact before truncation/splitting so a secret crossing a boundary stays private. */
export function slackChunks(text: string, secrets: string[], maxChars: number): string[] {
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).replace(/[\ud800-\udbff]$/, '') + '\n[Answer truncated by Bridge.]';
  }
  const chunks: string[] = [];
  let chunk = '';
  // Split only between Unicode code points and escaped entities.
  for (const character of text) {
    const escaped = character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : character;
    if (chunk.length + escaped.length > MESSAGE_CHARS) { chunks.push(chunk); chunk = ''; }
    chunk += escaped;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export interface SlackPost {
  channel: string;
  thread_ts?: string;
  text: string;
  mrkdwn: false;
  parse: 'none';
  link_names: false;
  unfurl_links: false;
  unfurl_media: false;
}

export interface SlackSender { post(message: SlackPost): Promise<void> }

export async function sendText(sender: SlackSender, channel: string, thread: string | undefined, text: string, secrets: string[], maxChars: number): Promise<void> {
  for (const chunk of slackChunks(text, secrets, maxChars)) {
    await sender.post({ channel, thread_ts: thread, text: chunk, mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
  }
}
