// api/_lib/cron-runs.js
// Helpers for cron observability (audit Decision #4). Each cron handler
// calls startRun at the top and finishRun before every return path.
//
// Usage:
//   var cronRuns = require('./_lib/cron-runs');
//   module.exports = async function handler(req, res) {
//     var user = await auth.requireAdminOrInternal(req, res);
//     if (!user) return;
//
//     var runId = await cronRuns.start('process-queue');
//     try {
//       ... work ...
//       await cronRuns.finish(runId, 'success', { detail: { processed: n } });
//       return res.status(200).json({...});
//     } catch (err) {
//       await cronRuns.finish(runId, 'error', { error: err });
//       throw err;
//     }
//   };
//
// Both helpers are fault-tolerant: a Supabase outage that prevents logging
// never blocks the cron itself. They log to Vercel stdout on failure so the
// outage surfaces in logs.

var sb = require('./supabase');

async function start(cronName, snapshot) {
  try {
    var row = {
      cron_name: cronName,
      status: 'running'
    };
    if (snapshot && typeof snapshot === 'object') {
      if (snapshot.queue_depth != null) row.queue_depth = snapshot.queue_depth;
      if (snapshot.oldest_item_age_sec != null) row.oldest_item_age_sec = snapshot.oldest_item_age_sec;
    }
    var rows = await sb.mutate('cron_runs', 'POST', row);
    return (Array.isArray(rows) && rows[0] && rows[0].id) ? rows[0].id : null;
  } catch (e) {
    console.error('cron-runs.start failed for ' + cronName + ': ' + (e && e.message ? e.message : ''));
    return null;
  }
}

// Non-terminal PATCH for in-progress telemetry (queue_depth, oldest age).
// Called by a handler before its main work so the cron_runs row reflects
// the queue snapshot at start. Wrapper's finish() does not overwrite these
// fields unless explicitly passed new values, so the snapshot survives.
async function snapshot(runId, opts) {
  if (!runId || !opts) return;
  try {
    var patch = {};
    if (opts.queue_depth != null) patch.queue_depth = opts.queue_depth;
    if (opts.oldest_item_age_sec != null) patch.oldest_item_age_sec = opts.oldest_item_age_sec;
    if (opts.detail) patch.detail = opts.detail;
    if (Object.keys(patch).length === 0) return;
    await sb.mutate('cron_runs?id=eq.' + runId, 'PATCH', patch, 'return=minimal');
  } catch (e) {
    // 2026-04-26: log full diagnostic. Previous catch printed only e.message,
    // which was empty when fetches died on lambda freeze (the fire-and-forget
    // IIFE outlived the response). Include name/status/detail so any future
    // failure surfaces something useful in stdout.
    var bits = [];
    if (e && e.name) bits.push('name=' + e.name);
    if (e && e.message) bits.push('msg=' + String(e.message).substring(0, 240));
    else bits.push('msg=<empty>');
    if (e && e.status) bits.push('http=' + e.status);
    if (e && e.code) bits.push('code=' + e.code);
    if (e && e.cause && e.cause.code) bits.push('causeCode=' + e.cause.code);
    console.error('cron-runs.snapshot failed: ' + bits.join(' '));
  }
}

async function finish(runId, status, opts) {
  if (!runId) return;
  opts = opts || {};
  try {
    var patch = {
      completed_at: new Date().toISOString(),
      status: status || 'success'
    };
    if (opts.error) {
      var msg = opts.error instanceof Error ? opts.error.message : String(opts.error);
      patch.error = msg.substring(0, 1000);
    }
    if (opts.queue_depth != null) patch.queue_depth = opts.queue_depth;
    if (opts.oldest_item_age_sec != null) patch.oldest_item_age_sec = opts.oldest_item_age_sec;
    if (opts.detail) patch.detail = opts.detail;
    await sb.mutate('cron_runs?id=eq.' + runId, 'PATCH', patch, 'return=minimal');
  } catch (e) {
    console.error('cron-runs.finish failed: ' + (e && e.message ? e.message : ''));
  }
}

// Wrap a cron handler so that every invocation is automatically tracked.
// Writes a cron_runs row at start and updates it in a finally block,
// regardless of which path the handler returned through. Failures from
// cron_runs itself never propagate — observability should not block work.
//
// Auth-failure invocations (401) are logged as 'error' runs. In practice
// Vercel's signed CRON_SECRET header means that only occurs for an
// adversary, which is data worth having anyway.
//
// 2026-04-22: rewritten to commit the cron_runs completion PATCH BEFORE
// sending the HTTP response, not after. Vercel halts all processing as
// soon as a response is sent (confirmed behavior of Vercel Node Functions
// and Fluid compute — see vercel/vercel#4314 and the waitUntil changelog),
// so any work in a post-return finally block is not guaranteed to run.
// The prior design relied on `finally { await finish(runId, ...) }` firing
// after `return res.status(X).json(...)`, which lost the race on every
// successful check-surge-blocks run (28/28 silent-fail window on 04-21/22),
// ~12% of cleanup-stale-runs, and all observed cleanup-rate-limits runs.
//
// The new design intercepts res.json so the handler's `return res.status(X)
// .json(body)` stores body + statusCode instead of flushing. After the
// handler returns, the wrapper PATCHes cron_runs synchronously, THEN flushes
// the real response with the captured body. Handlers that use the standard
// `return res.status(X).json({...})` shape — all 12 withTracking callers at
// time of writing — continue to work unchanged because our stubbed json()
// still returns `res`, preserving chaining.
//
// Non-intercepted methods (res.send, res.end, res.write) are NOT supported
// here: if a withTracking'd handler ever uses one of those, the response
// flushes immediately and we're back in the race. Audited 2026-04-22:
// zero such usages across the 12 cron handlers.
function withTracking(name, innerHandler) {
  return async function wrapped(req, res) {
    var runId = await start(name);
    // Expose to the inner handler so it can emit mid-run telemetry via
    // cronRuns.snapshot(req._cronRunId, { queue_depth, oldest_item_age_sec }).
    if (req) req._cronRunId = runId;

    // Capture-and-defer shim on res.json. Handler-side semantics are
    // unchanged: statusCode is set by res.status() before json() is called,
    // so we just record body + read statusCode at capture time.
    var capturedBody = null;
    var captured = false;
    var origJson = null;
    if (res && typeof res.json === 'function') {
      origJson = res.json.bind(res);
      res.json = function(body) {
        capturedBody = body;
        captured = true;
        return res;
      };
    }

    var capturedErr = null;
    try {
      await innerHandler(req, res);
    } catch (e) {
      capturedErr = e;
    }

    // 2026-04-26: if the handler kicked off a parallel snapshot promise via
    // req._snapshotPromise (Pattern B in cron snapshot rewrite), wait for it
    // to settle BEFORE we flush the response. Previously snapshots were
    // fire-and-forget, which meant they'd lose their in-flight Supabase fetch
    // when the lambda froze right after the response — producing the
    // 'cron-runs.snapshot failed: ' empty-message log spam. Snapshot is
    // self-bounded by sb.mutate's 25s default timeout, and snapshot() never
    // throws (it catches and logs), so awaiting here can't slow or break
    // the cron beyond the fetchT timeout in the worst case.
    if (req && req._snapshotPromise && typeof req._snapshotPromise.then === 'function') {
      try { await req._snapshotPromise; } catch (e) { /* snapshot logs its own */ }
    }

    // Determine terminal status. Handler-thrown exceptions always count as
    // error. Handler-returned >=400 statusCodes also count as error (matches
    // the prior wrapper's intent of catching handlers that swallow their
    // own exceptions and respond 500).
    var effectiveStatus = res && res.statusCode ? res.statusCode : (captured ? 200 : 500);
    var isError = !!capturedErr || effectiveStatus >= 400;
    var status = isError ? 'error' : 'success';

    // Synthesize an error string for cron_runs.error when none is available
    // from a thrown exception. Matches the prior behavior for handlers that
    // catch and respond with 500 — we want cron_runs.error populated with a
    // useful diagnostic, not left null.
    var errForFinish = capturedErr;
    if (!errForFinish && isError) {
      var summary = 'HTTP ' + effectiveStatus;
      if (capturedBody && typeof capturedBody === 'object') {
        if (capturedBody.error) summary += ': ' + String(capturedBody.error).substring(0, 300);
        else if (capturedBody.message) summary += ': ' + String(capturedBody.message).substring(0, 300);
      } else if (typeof capturedBody === 'string') {
        summary += ': ' + capturedBody.substring(0, 300);
      }
      errForFinish = new Error(summary);
    }

    // Commit cron_runs completion FIRST, while Vercel still considers the
    // function in-flight. finish() is already fault-tolerant — a Supabase
    // outage logs to stdout but doesn't throw — so this is safe to await
    // inline on the critical path.
    if (runId) {
      await finish(runId, status, { error: errForFinish });
    }

    // Now flush the actual response.
    if (captured && origJson) {
      return origJson(capturedBody);
    }
    if (capturedErr) {
      // Handler threw without sending a response (no res.json intercept
      // fired). Send a generic 500 so the client sees something.
      try {
        if (res && typeof res.status === 'function') res.status(500);
        if (origJson) return origJson({ error: 'Internal error' });
      } catch (e) { /* swallow — cron_runs already recorded the failure */ }
    }
    // Neither captured nor errored: handler responded via a non-intercepted
    // path (res.end, res.send, stream, etc.). Nothing to flush. cron_runs
    // is at least in the correct terminal state.
  };
}

module.exports = {
  start: start,
  snapshot: snapshot,
  finish: finish,
  withTracking: withTracking
};
