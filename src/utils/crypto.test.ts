import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, randomToken, safeEqual, sha256 } from './crypto.js';
import { stripMongoOperators } from '../middleware/sanitize.js';

const KEY = 'ab'.repeat(32);

describe('crypto helpers', () => {
  it('round-trips AES-GCM and uses a fresh IV each time', () => {
    const a = encrypt('JBSWY3DPEHPK3PXP', KEY);
    const b = encrypt('JBSWY3DPEHPK3PXP', KEY);
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detects tampering', () => {
    const [iv, tag, enc] = encrypt('secret', KEY).split('.');
    const flipped = `${iv}.${tag}.${(enc ?? '').slice(0, -1)}${(enc ?? '').endsWith('A') ? 'B' : 'A'}`;
    expect(() => decrypt(flipped, KEY)).toThrow();
  });

  it('hashes and compares', () => {
    expect(sha256('x')).toHaveLength(64);
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('stripMongoOperators', () => {
  it('removes operator and dotted keys at any depth', () => {
    expect(
      stripMongoOperators({ email: { $gt: '' }, nested: [{ 'a.b': 1, ok: 2, $where: 'x' }], __proto__: { polluted: true } }),
    ).toEqual({ email: {}, nested: [{ ok: 2 }] });
  });
});
