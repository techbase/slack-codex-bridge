/** A harness-owned prompt. Bridge transports it without deciding what is allowed. */
export interface Interaction {
  text: string;
  instructions: string;
  parse(action: 'approve' | 'deny' | 'answer', text: string): unknown | undefined;
}

export type Interact = (prompt: Interaction, signal: AbortSignal) => Promise<unknown>;
