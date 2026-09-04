export interface PayloadHasher {
  hash(payload: Readonly<Record<string, unknown>>): string;
}
