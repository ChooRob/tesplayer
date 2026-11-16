import { createHmac } from 'node:crypto';

// The ID a viewer can post publicly to ask for more watch time or streams. It
// stands in for the account's limit key (plex:<ID> or jellyfin:<server ID>), which
// would reveal the real Plex account or server identifier. It is a keyed hash of
// that key, so it cannot be turned back into it, and the same account always gets
// the same code. Administrators find the account by recomputing the code for the
// accounts they know (see accounts.js); nothing is stored.
//
// Format: FSC-XXXX-XXXX-XXXX-XXXX, 80 bits in Crockford base32 (no I, L, O or U,
// so it survives being read aloud or retyped).

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 16;

export function createPublicAccountIds(secret) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('Public account IDs need a private secret.');

  function publicId(key) {
    const digest = createHmac('sha256', secret).update('public-account-id\0' + key).digest().subarray(0, CODE_LENGTH * 5 / 8);
    let bits = 0;
    let value = 0;
    let code = '';
    for (const byte of digest) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        code += ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
      value &= (1 << bits) - 1;
    }
    return 'FSC-' + code.match(/.{4}/g).join('-');
  }

  // The canonical ID for whatever was typed or pasted (any case, with or without
  // dashes, spaces or the FSC prefix, O and I/L read as 0 and 1), or null when the
  // text is not shaped like one.
  function parse(text) {
    if (typeof text !== 'string') return null;
    let cleaned = text.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (cleaned.length === CODE_LENGTH + 3 && cleaned.startsWith('FSC')) cleaned = cleaned.slice(3);
    if (cleaned.length !== CODE_LENGTH || [...cleaned].some(char => !ALPHABET.includes(char))) return null;
    return 'FSC-' + cleaned.match(/.{4}/g).join('-');
  }

  return { publicId, parse };
}
