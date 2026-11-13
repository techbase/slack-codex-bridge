/** A harness-owned prompt. Bridge transports it without deciding what is allowed. */
export interface Interaction {
  kind: 'approval' | 'input';
  text: string;
  instructions: string;
  parse(action: 'approve' | 'deny' | 'answer', text: string): unknown | undefined;
}

export type Interact = (prompt: Interaction, signal: AbortSignal) => Promise<unknown>;

/** Only short, unconditional replies to a live approval; prose is conversation. */
export function approvalReply(text: string): 'approve' | 'deny' | undefined {
  if (/[\r\n]/.test(text)) return;
  const answer = text.trim().toLowerCase().replace(/[.!]+$/, '').replace(/,\s*/g, ' ');
  if (['approve', 'approved', 'yes', 'yes please', 'yes go ahead', 'go ahead'].includes(answer)) return 'approve';
  if (['deny', 'denied', 'no', 'no thanks', 'no thank you'].includes(answer)) return 'deny';
}
