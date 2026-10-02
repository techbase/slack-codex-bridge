export const MESSAGE_CHARS = 3000;

function escape(text: string): string {
  return text.replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!);
}

/** Preserve web links, but never Slack mentions, channel references or other controls. */
function webLink(token: string): string | undefined {
  const match = /^<(https?:\/\/[^\s<>|]+)(?:\|([^<>|\r\n]+))?>$/.exec(token);
  if (!match || (match[2] !== undefined && !match[2].trim())) return;
  try {
    const url = new URL(match[1]!);
    if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) return;
  } catch { return; }
  const link = `<${escape(match[1]!)}${match[2] === undefined ? '' : `|${escape(match[2])}`}>`;
  // An oversized link remains literal text rather than being split as active markup.
  return link.length <= MESSAGE_CHARS ? link : undefined;
}

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
  const append = (token: string) => {
    if (chunk.length + token.length > MESSAGE_CHARS) {
      // Keep ordinary paragraphs and headings together where there is room.
      const newline = chunk.lastIndexOf('\n') + 1;
      if (newline >= MESSAGE_CHARS / 2) {
        chunks.push(chunk.slice(0, newline));
        chunk = chunk.slice(newline);
      }
      if (chunk.length + token.length > MESSAGE_CHARS) { chunks.push(chunk); chunk = ''; }
    }
    chunk += token;
  };
  // Web links are atomic; other text splits only between code points/entities.
  for (const [token] of text.matchAll(/<[^<>\n]*>|[\s\S]/gu)) {
    const link = webLink(token);
    if (link) append(link);
    else for (const character of token) append(escape(character));
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export interface SlackPost {
  channel: string;
  thread_ts?: string;
  text: string;
  mrkdwn: true;
  link_names: false;
  unfurl_links: false;
  unfurl_media: false;
}

export interface SlackSender { post(message: SlackPost): Promise<void> }

export async function sendText(sender: SlackSender, channel: string, thread: string | undefined, text: string, secrets: string[], maxChars: number): Promise<void> {
  for (const chunk of slackChunks(text, secrets, maxChars)) {
    await sender.post({ channel, thread_ts: thread, text: chunk, mrkdwn: true, link_names: false, unfurl_links: false, unfurl_media: false });
  }
}
