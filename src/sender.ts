/** Delivers one message to the user. */
export interface Sender {
  send(text: string): Promise<void>;
}
