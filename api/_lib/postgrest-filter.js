// api/_lib/postgrest-filter.js
// PostgREST filter builder with injection-safe value encoding.
//
// Replaces the inline `buildFilter` that lived in api/action.js and
// api/onboarding-action.js. Those copies passed operator-prefixed strings
// through unencoded — an attacker with a compromised admin JWT could send
// filters like  {"id":"eq.1)&other_col=eq.value"}  and splice additional
// filter clauses into the PostgREST URL.
//
// The fix: the VALUE portion of every filter is always URL-encoded, regardless
// of how it arrived (primitive, operator-prefixed string, structured {op,value}).
// Operators are allowlisted. Keys are column-name-shaped or rejected.
//
// Accepted input shapes for each filter value:
//   - primitive  (number | string | boolean)    → col=eq.<encoded>
//   - 'eq.foo' string (operator prefix)         → col=eq.<encoded("foo")>
//   - { op: 'eq', value: 'foo' }                → col=eq.<encoded("foo")>
//   - { op: 'in', value: ['a','b'] }            → col=in.(<enc(a)>,<enc(b)>)
//   - { op: 'is', value: null }                 → col=is.null
//   - arrays and bare 'is.null' strings are also handled
//
// Anything outside this envelope is rejected (throws), not silently passed
// through. The caller's handler should catch and return 400.

// PostgREST operators we allow. Others (cs, cd, ov, sl, sr, not.*, etc.) are
// either unused in our codebase or would need dedicated handling. Expand this
// list deliberately when a real need appears.
var ALLOWED_OPS = [
  'eq', 'neq',
  'gt', 'gte', 'lt', 'lte',
  'like', 'ilike',
  'in',
  'is'
];

// Column keys must be plain identifiers. Anything else is suspicious — the
// PostgREST URL is key=value&key=value, so a rogue key could inject an extra
// parameter (e.g. `delete=true`, `limit=10000`).
var KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function isPrimitive(v) {
  var t = typeof v;
  return v === null || t === 'number' || t === 'string' || t === 'boolean';
}

// Build a PostgREST filter querystring from a {col: value} map.
// Returns a string like 'id=eq.abc&status=eq.active' (no leading '?' or '&').
// Throws on malformed input — the caller should 400.
function buildFilter(filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new Error('filters must be an object');
  }

  var parts = [];

  for (var key in filters) {
    if (!Object.prototype.hasOwnProperty.call(filters, key)) continue;
    if (!KEY_RE.test(key)) {
      throw new Error('filter key not allowed: ' + key);
    }

    var val = filters[key];
    parts.push(key + '=' + encodeValue(val));
  }

  return parts.join('&');
}

// Encode a single filter value to the right-hand side of `col=...`.
// All branches end with URL-encoded content; no passthrough exists.
function encodeValue(val) {
  // Structured form: { op, value }
  if (val && typeof val === 'object' && !Array.isArray(val) && ('op' in val || 'value' in val)) {
    var op = String(val.op || 'eq').toLowerCase();
    if (ALLOWED_OPS.indexOf(op) === -1) {
      throw new Error('filter operator not allowed: ' + op);
    }
    return op + '.' + encodeOperand(op, val.value);
  }

  // Bare array → in.(...)
  if (Array.isArray(val)) {
    return 'in.' + encodeInList(val);
  }

  // Operator-prefixed string, e.g. 'eq.sky-therapies' — the AI chat
  // assistant emits this shape. Split at the first dot, allowlist the op,
  // URL-encode the remainder.
  if (typeof val === 'string') {
    var m = val.match(/^([a-z]+)\.(.*)$/i);
    if (m && ALLOWED_OPS.indexOf(m[1].toLowerCase()) !== -1) {
      var opStr = m[1].toLowerCase();
      var rest = m[2];
      // Special case 'is.null' / 'is.true' / 'is.false' — PostgREST expects
      // these literal tokens unencoded.
      if (opStr === 'is') return 'is.' + encodeIsOperand(rest);
      if (opStr === 'in') {
        // AI sometimes emits 'in.(a,b,c)' as a literal. Parse it.
        var inner = rest.replace(/^\(/, '').replace(/\)$/, '');
        var items = inner.split(',').map(function(s) { return s.trim(); });
        return 'in.' + encodeInList(items);
      }
      return opStr + '.' + encodeURIComponent(rest);
    }
    // No recognized prefix → treat as implicit eq (no injection risk: always encoded)
    return 'eq.' + encodeURIComponent(val);
  }

  // Primitive number / boolean
  if (isPrimitive(val)) {
    return 'eq.' + encodeURIComponent(String(val));
  }

  throw new Error('filter value type not supported');
}

function encodeOperand(op, value) {
  if (op === 'is') return encodeIsOperand(value);
  if (op === 'in') return encodeInList(Array.isArray(value) ? value : [value]);
  if (value === null || value === undefined) {
    throw new Error('operator ' + op + ' requires a value');
  }
  if (!isPrimitive(value)) {
    throw new Error('operator ' + op + ' requires primitive value');
  }
  return encodeURIComponent(String(value));
}

// PostgREST accepts `is.null`, `is.true`, `is.false`, `is.not null` unquoted.
// We map JS null/true/false to these tokens; strings are allowlist-checked.
function encodeIsOperand(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  var s = String(value).toLowerCase().trim();
  if (s === 'null' || s === 'true' || s === 'false' || s === 'not null' || s === 'not.null') {
    return s.replace(/\s+/g, '.');
  }
  throw new Error('is.<operand> must be null|true|false');
}

// `in.(a,b,c)` — each item URL-encoded, commas literal.
function encodeInList(items) {
  if (!Array.isArray(items)) throw new Error('in.* requires an array');
  var parts = items.map(function(v) {
    if (!isPrimitive(v) || v === null) {
      throw new Error('in.* requires primitive items');
    }
    return encodeURIComponent(String(v));
  });
  return '(' + parts.join(',') + ')';
}

module.exports = {
  buildFilter: buildFilter,
  ALLOWED_OPS: ALLOWED_OPS
};
