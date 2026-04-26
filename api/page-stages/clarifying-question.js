// /api/page-stages/clarifying-question.js
// Mark a clarifying question on a stage run as acknowledged, or as the basis
// for a rerun. Mutates findings_summary.clarifying_questions[i] in place.
//
// PATCH /api/page-stages/clarifying-question
//   body: { run_id, question_index, action: 'acknowledge' | 'rerun_with_choice', choice?, note? }
//
//   - 'acknowledge': sets acknowledged_at on the question. Notification clears.
//     The decision_taken Claude already made stands.
//   - 'rerun_with_choice': sets acknowledged_at, records the operator's choice
//     and optional note onto the question, and returns operator_notes text the
//     UI should pre-fill into the next stage rerun. Does NOT fire the rerun
//     itself — admin clicks the Rerun button explicitly afterward.
//
// Auth: admin JWT or CRON_SECRET (internal callers can also use this if needed).

var auth = require('../_lib/auth');
var sb   = require('../_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var body = req.body || {};
  var runId = body.run_id || '';
  var qIdx  = (typeof body.question_index === 'number') ? body.question_index : -1;
  var action = body.action || '';
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return res.status(400).json({ error: 'invalid run_id' });
  if (qIdx < 0) return res.status(400).json({ error: 'question_index required' });
  if (action !== 'acknowledge' && action !== 'rerun_with_choice') {
    return res.status(400).json({ error: 'action must be acknowledge or rerun_with_choice' });
  }
  if (action === 'rerun_with_choice' && !body.choice && !body.note) {
    return res.status(400).json({ error: 'choice or note required for rerun_with_choice' });
  }

  try {
    var run = await sb.one('page_stage_runs?id=eq.' + runId + '&select=findings_summary,stage&limit=1');
    if (!run) return res.status(404).json({ error: 'Run not found' });

    var fs = run.findings_summary || {};
    var qs = Array.isArray(fs.clarifying_questions) ? fs.clarifying_questions.slice() : [];
    if (qIdx >= qs.length) return res.status(400).json({ error: 'question_index out of range' });

    var q = Object.assign({}, qs[qIdx]);
    q.acknowledged_at = new Date().toISOString();
    q.acknowledged_by = user.id || user.email || 'admin';
    if (action === 'rerun_with_choice') {
      q.operator_choice = body.choice || '';
      q.operator_note = body.note || '';
    }
    qs[qIdx] = q;

    var newFs = Object.assign({}, fs, { clarifying_questions: qs });
    await sb.mutate('page_stage_runs?id=eq.' + runId, 'PATCH', {
      findings_summary: newFs
    }, 'return=minimal');

    // For rerun_with_choice, build the operator_notes text the UI can pre-fill
    // into the rerun call so the next stage sees the decision.
    var rerunNotes = '';
    if (action === 'rerun_with_choice') {
      rerunNotes = 'Operator decision on prior clarifying question:\n' +
                   '- Topic: ' + (q.topic || '') + '\n' +
                   '- Question: ' + (q.question || '').slice(0, 500) + '\n' +
                   (q.operator_choice ? '- Choice: ' + q.operator_choice + '\n' : '') +
                   (q.operator_note ? '- Note: ' + q.operator_note + '\n' : '') +
                   'Apply this decision in this rerun.';
    }

    return res.status(200).json({
      success: true,
      stage: run.stage,
      question_index: qIdx,
      acknowledged_at: q.acknowledged_at,
      rerun_notes: rerunNotes || null
    });
  } catch (e) {
    console.error('[page-stages/clarifying-question]', e.message);
    return res.status(500).json({ error: 'Update failed', detail: e.message });
  }
};
