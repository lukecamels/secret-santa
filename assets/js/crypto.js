/* Secret Santa - browser crypto helpers.
 *
 * Everything sensitive is encrypted in the browser. The public data file and the
 * API server only ever hold opaque ciphertext plus salts and hashes.
 */
(function (global) {
  'use strict';

  var te = new TextEncoder();
  var td = new TextDecoder();

  // Crockford-style base32: no I, L, O or U, so tokens are easy to read aloud.
  var ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  var TOKEN_CHARS = 20;            // 20 chars x 5 bits = 100 bits of entropy
  var PBKDF2_ITERATIONS = 310000;

  function b64uEncode(bytes) {
    var b = new Uint8Array(bytes);
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64uDecode(str) {
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    var pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    var bin = atob(s + pad);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }

  function concat() {
    var parts = Array.prototype.slice.call(arguments).map(function (p) {
      return p instanceof Uint8Array ? p : new Uint8Array(p);
    });
    var total = parts.reduce(function (n, p) { return n + p.length; }, 0);
    var out = new Uint8Array(total);
    var offset = 0;
    parts.forEach(function (p) { out.set(p, offset); offset += p.length; });
    return out;
  }

  function sha256(bytes) {
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  /* ---- tokens ---------------------------------------------------------- */

  function generateToken() {
    var raw = randomBytes(TOKEN_CHARS);   // 256 % 32 === 0, so this stays uniform
    var out = '';
    for (var i = 0; i < TOKEN_CHARS; i++) {
      out += ALPHABET[raw[i] % 32];
      if (i % 5 === 4 && i < TOKEN_CHARS - 1) out += '-';
    }
    return out;
  }

  // Forgiving input: case, spaces and dashes don't matter, and the characters
  // left out of the alphabet are folded onto the ones they look like.
  function normalizeToken(input) {
    return String(input || '')
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '')
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1')
      .replace(/U/g, 'V');
  }

  function formatToken(normalized) {
    return (normalized.match(/.{1,5}/g) || []).join('-');
  }

  /* ---- per-person record ----------------------------------------------- */

  // Public lookup key for a token. SHA-256 is fine here: the token itself
  // carries 100 bits, so there is nothing to brute force.
  function recordId(saltB64, token) {
    return sha256(concat(b64uDecode(saltB64), te.encode('rec-id|' + token)))
      .then(function (h) { return b64uEncode(h.slice(0, 16)); });
  }

  function deriveRecordKey(token, saltB64, iterations) {
    return crypto.subtle
      .importKey('raw', te.encode(token), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          {
            name: 'PBKDF2',
            salt: concat(b64uDecode(saltB64), te.encode('rec-key')),
            iterations: iterations || PBKDF2_ITERATIONS,
            hash: 'SHA-256'
          },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      });
  }

  /* ---- mailboxes ------------------------------------------------------- */

  function generateSecret() { return b64uEncode(randomBytes(32)); }

  function generateMailboxId() { return b64uEncode(randomBytes(16)); }

  function importAesKey(b64) {
    return crypto.subtle.importKey('raw', b64uDecode(b64), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  // Published alongside the mailbox id so the API can check writes without
  // ever holding the secret itself.
  function authHash(secretB64) {
    return sha256(te.encode(secretB64)).then(b64uEncode);
  }

  /* ---- AES-GCM --------------------------------------------------------- */

  function encryptJson(key, obj) {
    var iv = randomBytes(12);
    return crypto.subtle
      .encrypt({ name: 'AES-GCM', iv: iv }, key, te.encode(JSON.stringify(obj)))
      .then(function (ct) { return b64uEncode(concat(iv, new Uint8Array(ct))); });
  }

  function decryptJson(key, blob) {
    var raw = b64uDecode(blob);
    return crypto.subtle
      .decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12))
      .then(function (pt) { return JSON.parse(td.decode(pt)); });
  }

  global.SSCrypto = {
    PBKDF2_ITERATIONS: PBKDF2_ITERATIONS,
    TOKEN_LENGTH: TOKEN_CHARS,
    b64uEncode: b64uEncode,
    b64uDecode: b64uDecode,
    randomBytes: randomBytes,
    generateToken: generateToken,
    normalizeToken: normalizeToken,
    formatToken: formatToken,
    recordId: recordId,
    deriveRecordKey: deriveRecordKey,
    generateSecret: generateSecret,
    generateMailboxId: generateMailboxId,
    importAesKey: importAesKey,
    authHash: authHash,
    encryptJson: encryptJson,
    decryptJson: decryptJson
  };
})(window);
