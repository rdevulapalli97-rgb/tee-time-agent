/**
 * lib/encrypt.js — AES-256-GCM credential encryption
 *
 * Credentials are encrypted in the application layer before being stored
 * in Supabase. This means even if the database is compromised, credentials
 * remain unreadable without the ENCRYPTION_KEY env variable.
 *
 * Algorithm: AES-256-GCM
 *   - 256-bit key derived from ENCRYPTION_KEY env var via SHA-256
 *   - Random 12-byte IV per encryption operation
 *   - 16-byte GCM authentication tag prevents tampering
 *   - All binary values stored as base64 strings
 *
 * Setup:
 *   Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   Add ENCRYPTION_KEY=<that value> to your .env
 */

'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96 bits — recommended for GCM
const TAG_LENGTH = 16;  // 128 bits

function getDerivedKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('[encrypt] ENCRYPTION_KEY is not set in environment');
  // Derive a 32-byte key regardless of input length
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Encrypt a plaintext string.
 * Returns { ciphertext, iv, authTag } — all base64-encoded strings.
 * Store all three alongside the encrypted value in the DB.
 */
function encrypt(plaintext) {
  const key  = getDerivedKey();
  const iv   = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);

  return {
    ciphertext: encrypted.toString('base64'),
    iv:         iv.toString('base64'),
    authTag:    cipher.getAuthTag().toString('base64')
  };
}

/**
 * Decrypt a previously encrypted value.
 * Pass the same { ciphertext, iv, authTag } that encrypt() returned.
 * Returns the original plaintext string.
 * Throws if the key is wrong or data has been tampered with.
 */
function decrypt({ ciphertext, iv, authTag }) {
  const key      = getDerivedKey();
  const ivBuf    = Buffer.from(iv, 'base64');
  const tagBuf   = Buffer.from(authTag, 'base64');
  const dataBuf  = Buffer.from(ciphertext, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tagBuf);

  return decipher.update(dataBuf) + decipher.final('utf8');
}

/**
 * Encrypt a username/password pair for Supabase storage.
 * Returns the shape expected by db/client.js → upsertCredentials().
 */
function encryptCredentials({ username, password }) {
  const user = encrypt(username);
  const pass = encrypt(password);

  // Use the same IV for both (they're encrypted separately but stored together)
  // Actually use separate IVs for true independence — just pair them
  return {
    username_enc: user.ciphertext,
    password_enc: pass.ciphertext,
    iv:           user.iv,          // primary IV (for username)
    auth_tag:     user.authTag,     // primary auth tag
    // Store password's IV and tag alongside so we can decrypt it
    // We store them as a single JSON string in auth_tag for simplicity
    _password_iv:      pass.iv,
    _password_auth_tag: pass.authTag,
  };
}

/**
 * Full round-trip: encrypt credentials in the shape Supabase expects.
 * Returns exactly the fields that upsertCredentials() needs.
 */
function packCredentials(username, password) {
  const user = encrypt(username);
  const pass = encrypt(password);

  // Pack both sets of crypto material into the four DB columns
  // iv and auth_tag store JSON so we can unpack both username and password
  return {
    username_enc: user.ciphertext,
    password_enc: pass.ciphertext,
    iv:           JSON.stringify({ u: user.iv,      p: pass.iv }),
    auth_tag:     JSON.stringify({ u: user.authTag, p: pass.authTag })
  };
}

/**
 * Unpack credentials from the DB row returned by getCredentials().
 * Returns { username, password } as plaintext strings.
 */
function unpackCredentials(row) {
  const ivs  = JSON.parse(row.iv);
  const tags = JSON.parse(row.auth_tag);

  const username = decrypt({ ciphertext: row.username_enc, iv: ivs.u, authTag: tags.u });
  const password = decrypt({ ciphertext: row.password_enc, iv: ivs.p, authTag: tags.p });

  return { username, password };
}

/**
 * Quick self-test — call from your setup script to verify the key works.
 */
function selfTest() {
  const original = { username: 'test_user@example.com', password: 'S3cur3P@ssword!' };
  const packed   = packCredentials(original.username, original.password);
  const unpacked = unpackCredentials(packed);

  const ok = unpacked.username === original.username && unpacked.password === original.password;
  console.log(ok ? '[encrypt] ✅ Self-test passed' : '[encrypt] ❌ Self-test FAILED');
  return ok;
}

module.exports = { encrypt, decrypt, packCredentials, unpackCredentials, selfTest };
