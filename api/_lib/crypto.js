// api/_lib/crypto.js
// Application-level AES-256-GCM encryption for sensitive fields.
//
// Used by:
//   - api/action.js to auto encrypt/decrypt workspace_credentials
//   - api/enrich-proposal.js to encrypt the sensitive subtree of
//     proposals.enrichment_data (emails[] and calls[])
//   - api/generate-proposal.js to decrypt the sensitive subtree when
//     building the Claude prompt context
//   - api/admin/backfill-enrichment-encryption.js for the one-shot
//     re-shaping of legacy pre-H29 rows
//
// ─── Key versioning / rotation ──────────────────────────────────────
//
// The module supports two key slots to enable key rotation without a
// downtime window. Each ciphertext is tagged with its version prefix
// ('v1:' or 'v2:'); decrypt() looks up the matching key based on the
// prefix. encrypt() uses whichever version is currently active.
//
//   Env vars:
//     CREDENTIALS_ENCRYPTION_KEY            — the v1 key (32-byte hex)
//     CREDENTIALS_ENCRYPTION_KEY_V2         — optional v2 key (32-byte hex)
//     CREDENTIALS_ENCRYPTION_ACTIVE_VERSION — 'v1' | 'v2' (default 'v1')
//
//   Rotation procedure:
//     1. Generate a new 32-byte hex key:
//        node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"
//     2. Add CREDENTIALS_ENCRYPTION_KEY_V2 to Vercel env (all envs)
//     3. Redeploy. Decryption now accepts both prefixes.
//     4. Set CREDENTIALS_ENCRYPTION_ACTIVE_VERSION=v2 in Vercel env. Redeploy.
//        All new writes encrypt with v2; reads continue to handle v1 legacy.
//     5. Optionally run the re-encrypt backfill endpoint (future) to flip
//        all v1 ciphertext to v2 ciphertext.
//     6. Once no v1 ciphertext remains, delete CREDENTIALS_ENCRYPTION_KEY.
//
// Absent the rotation, the default shape (only CREDENTIALS_ENCRYPTION_KEY set,
// ACTIVE_VERSION unset or 'v1') produces byte-identical output to the
// pre-H29 implementation — every existing 'v1:' ciphertext continues to
// decrypt cleanly with zero migration.
//
// ─── JSON helpers ───────────────────────────────────────────────────
//
// encryptJSON(obj) and decryptJSON(ciphertext) wrap JSON.stringify + encrypt
// and decrypt + JSON.parse respectively. Used by enrich-proposal.js for the
// _sensitive envelope in proposals.enrichment_data.

var nodeCrypto = require('crypto');

var ALGO = 'aes-256-gcm';
var IV_BYTES = 12;
var PREFIX_V1 = 'v1:';
var PREFIX_V2 = 'v2:';

// Loud warning at module load if the v1 key is missing. Surfaces config issues
// in Vercel logs even before the first encrypt/decrypt call.
if (!process.env.CREDENTIALS_ENCRYPTION_KEY) {
  console.error('[crypto] CRITICAL: CREDENTIALS_ENCRYPTION_KEY is not set. encrypt() and decrypt() will throw on any call. Set the env var immediately.');
}

function getActiveVersion() {
  return process.env.CREDENTIALS_ENCRYPTION_ACTIVE_VERSION === 'v2' ? 'v2' : 'v1';
}

function getKey(version) {
  var envVar = version === 'v2' ? 'CREDENTIALS_ENCRYPTION_KEY_V2' : 'CREDENTIALS_ENCRYPTION_KEY';
  var hex = process.env[envVar];
  if (!hex) return null;
  return Buffer.from(hex, 'hex');
}

function prefixForVersion(version) {
  return version === 'v2' ? PREFIX_V2 : PREFIX_V1;
}

function versionFromPrefix(ciphertext) {
  if (ciphertext.indexOf(PREFIX_V1) === 0) return 'v1';
  if (ciphertext.indexOf(PREFIX_V2) === 0) return 'v2';
  return null;
}

// Encrypt a plaintext string. Returns \"<prefix>:iv_hex:ciphertext_hex:tag_hex\".
// Uses the currently-active key version. Throws if the active version's key
// is not configured — refusing to write plaintext is always safer than silent
// passthrough.
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  var version = getActiveVersion();
  var key = getKey(version);
  if (!key) {
    throw new Error('Encryption key for active version ' + version + ' not configured — refusing to write plaintext');
  }

  var iv = nodeCrypto.randomBytes(IV_BYTES);
  var cipher = nodeCrypto.createCipheriv(ALGO, key, iv);
  var encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  var tag = cipher.getAuthTag();

  return prefixForVersion(version) + iv.toString('hex') + ':' + encrypted.toString('hex') + ':' + tag.toString('hex');
}

// Decrypt a '<prefix>:iv:ciphertext:tag' string. Returns plaintext, or the
// original string if not prefixed (passthrough for legacy plaintext rows).
// Routes to the correct key based on the prefix, so rotation windows that
// have both v1 and v2 ciphertext in play work transparently.
function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
  var version = versionFromPrefix(ciphertext);
  if (!version) return ciphertext; // Not encrypted, return as-is

  var key = getKey(version);
  if (!key) {
    throw new Error('Encryption key for version ' + version + ' not configured — cannot decrypt');
  }

  var prefix = prefixForVersion(version);
  var parts = ciphertext.substring(prefix.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed ciphertext: expected 3 parts after ' + prefix + ' prefix');
  }

  try {
    var iv = Buffer.from(parts[0], 'hex');
    var encrypted = Buffer.from(parts[1], 'hex');
    var tag = Buffer.from(parts[2], 'hex');

    var decipher = nodeCrypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    var decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    throw new Error('Decryption failed: ' + e.message);
  }
}

// Encrypt a JS value by JSON.stringify-ing it first. Throws if stringify
// fails (circular refs, etc). Pairs with decryptJSON.
function encryptJSON(value) {
  if (value === null || value === undefined) return value;
  var str;
  try { str = JSON.stringify(value); }
  catch (e) { throw new Error('encryptJSON: stringify failed: ' + e.message); }
  return encrypt(str);
}

// Decrypt and JSON.parse the result. Returns the original value unchanged
// if it's not a prefixed ciphertext (legacy passthrough: if you pass an
// already-parsed object, you get it back). Throws on malformed ciphertext
// or bad JSON.
function decryptJSON(ciphertext) {
  if (ciphertext === null || ciphertext === undefined) return ciphertext;
  if (typeof ciphertext !== 'string') return ciphertext;
  if (!versionFromPrefix(ciphertext)) return ciphertext;
  var decrypted = decrypt(ciphertext);
  try { return JSON.parse(decrypted); }
  catch (e) { throw new Error('decryptJSON: JSON.parse failed: ' + e.message); }
}

// Detect whether a value is encrypted (prefixed ciphertext).
function isEncrypted(value) {
  return typeof value === 'string' && versionFromPrefix(value) !== null;
}

// Encrypt specific fields in an object. Returns a new object with encrypted values.
// Handles both string fields and text[] arrays of strings (encrypts each element).
// Idempotent: already-encrypted values pass through unchanged.
function encryptFields(obj, fields) {
  if (!obj) return obj;
  var result = Object.assign({}, obj);
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var v = result[f];
    if (v == null) continue;
    if (typeof v === 'string' && !isEncrypted(v)) {
      result[f] = encrypt(v);
    } else if (Array.isArray(v)) {
      result[f] = v.map(function(item) {
        return (typeof item === 'string' && !isEncrypted(item)) ? encrypt(item) : item;
      });
    }
  }
  return result;
}

// Decrypt specific fields in an object (or array of rows). Handles both
// string fields and text[] arrays of strings (decrypts each element).
// decrypt() passes through values without a known version prefix, so
// rows that pre-date encryption decrypt-through cleanly.
function decryptFields(data, fields) {
  if (!data) return data;
  if (Array.isArray(data)) {
    return data.map(function(row) { return decryptFields(row, fields); });
  }
  var result = Object.assign({}, data);
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var v = result[f];
    if (v == null) continue;
    if (typeof v === 'string') {
      result[f] = decrypt(v);
    } else if (Array.isArray(v)) {
      result[f] = v.map(function(item) {
        return typeof item === 'string' ? decrypt(item) : item;
      });
    }
  }
  return result;
}

// Check if encryption is configured for the currently-active version.
function isConfigured() {
  return !!getKey(getActiveVersion());
}

// The fields that should be encrypted for workspace_credentials.
// cms_login_url is NOT included — it's a plaintext URL (e.g. /wp-admin), not a secret.
//
// authenticator_* and qr_code_image were dropped 2026-04-18 and restored
// 2026-04-22 when it became clear the team actively needs client-Gmail
// recovery material in one place. The restored design masks all three
// by default in the admin UI (click-to-reveal, same pattern as
// gmail_password) so they never sit as standing plaintext in the DOM,
// and each text[] backup-code element is encrypted individually.
var SENSITIVE_FIELDS = [
  'gmail_password',
  'app_password',
  'authenticator_secret_key',
  'authenticator_backup_codes',
  'qr_code_image',
  'cms_username',
  'cms_password',
  'cms_app_password'
];

module.exports = {
  encrypt: encrypt,
  decrypt: decrypt,
  encryptJSON: encryptJSON,
  decryptJSON: decryptJSON,
  encryptFields: encryptFields,
  decryptFields: decryptFields,
  isEncrypted: isEncrypted,
  isConfigured: isConfigured,
  SENSITIVE_FIELDS: SENSITIVE_FIELDS,
  // Exposed for testing / rotation verification only; production callers
  // should use encrypt/decrypt (version routing is automatic).
  _getActiveVersion: getActiveVersion
};
