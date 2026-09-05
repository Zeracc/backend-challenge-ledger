export interface InboxIdentity {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}
export interface InboxState extends InboxIdentity {
  receivedAt: Date;
  processedAt?: Date;
  transactionId?: string;
}

export class InboxPayloadConflictError extends Error {
  public readonly code = 'INBOX_PAYLOAD_CONFLICT';
  public constructor() {
    super('O messageId já foi recebido com outro payload.');
  }
}

export class InboxMessage {
  private constructor(private readonly state: InboxState) {}

  public static receive(
    state: InboxIdentity & { receivedAt: Date },
  ): InboxMessage {
    if (
      !state.consumerName.trim() ||
      state.consumerName.length > 100 ||
      !state.messageId.trim() ||
      state.messageId.length > 200 ||
      !/^[a-f0-9]{64}$/.test(state.payloadHash)
    ) {
      throw new Error('Identidade de inbox inválida.');
    }
    return InboxMessage.rehydrate(state);
  }

  public static rehydrate(state: InboxState): InboxMessage {
    return new InboxMessage({
      ...state,
      receivedAt: new Date(state.receivedAt),
      ...(state.processedAt === undefined
        ? {}
        : { processedAt: new Date(state.processedAt) }),
    });
  }
  public get consumerName(): string {
    return this.state.consumerName;
  }
  public get messageId(): string {
    return this.state.messageId;
  }
  public get payloadHash(): string {
    return this.state.payloadHash;
  }
  public get receivedAt(): Date {
    return new Date(this.state.receivedAt);
  }
  public get processedAt(): Date | undefined {
    return this.state.processedAt === undefined
      ? undefined
      : new Date(this.state.processedAt);
  }
  public get transactionId(): string | undefined {
    return this.state.transactionId;
  }
  public isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }
  public assertPayload(hash: string): void {
    if (hash !== this.payloadHash) throw new InboxPayloadConflictError();
  }
  public markProcessed(transactionId: string, at: Date): void {
    if (this.isProcessed()) throw new Error('Inbox já processada.');
    this.state.transactionId = transactionId;
    this.state.processedAt = new Date(at);
  }
}
