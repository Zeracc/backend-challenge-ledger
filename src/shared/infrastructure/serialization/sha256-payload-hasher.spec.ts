import { describe, expect, it } from 'bun:test';

import { Sha256PayloadHasher } from './sha256-payload-hasher.js';

describe('Sha256PayloadHasher', () => {
  it('produz o mesmo hash para objetos com chaves em ordens diferentes', () => {
    const hasher = new Sha256PayloadHasher();

    const first = hasher.hash({
      providerId: 'provider-a',
      money: { currency: 'BRL', amount: '25.00' },
    });
    const second = hasher.hash({
      money: { amount: '25.00', currency: 'BRL' },
      providerId: 'provider-a',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produz hashes diferentes quando um campo de negócio muda', () => {
    const hasher = new Sha256PayloadHasher();

    expect(hasher.hash({ amount: '25.00' })).not.toBe(
      hasher.hash({ amount: '26.00' }),
    );
  });
});
