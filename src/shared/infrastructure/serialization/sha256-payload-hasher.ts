import { createHash } from 'node:crypto';

import type { PayloadHasher } from '../../application/ports/payload-hasher.js';

export class Sha256PayloadHasher implements PayloadHasher {
  public hash(payload: Readonly<Record<string, unknown>>): string {
    return createHash('sha256')
      .update(canonicalJson(payload), 'utf8')
      .digest('hex');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${canonicalJson(entryValue)}`,
    )
    .join(',')}}`;
}
