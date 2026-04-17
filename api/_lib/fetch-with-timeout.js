// api/_lib/fetch-with-timeout.js
// Wraps the global fetch() with an AbortController-backed timeout.
// Drop-in replacement: same signature as fetch() plus a trailing
// timeoutMs argument (default 25000).
//
// Usage:
//   var fetchT = require('./_lib/fetch-with-timeout');
//   var resp = await fetchT(url, opts, 10000);
//
// On timeout, throws `new Error('Timeout after Xms: <url>')` so Vercel
// logs tell you which endpoint hung. The leading "Timeout" prefix is
// stable so callers matching on `.message.includes('Timeout')` still
// work.

async function fetchWithTimeout(url, opts, timeoutMs) {
  timeoutMs = timeoutMs || 25000;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var mergedOpts = Object.assign({}, opts || {}, { signal: controller.signal });
    var resp = await fetch(url, mergedOpts);
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error('Timeout after ' + timeoutMs + 'ms: ' + url);
    }
    throw e;
  }
}

module.exports = fetchWithTimeout;
