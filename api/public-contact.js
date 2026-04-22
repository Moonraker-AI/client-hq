// /api/public-contact.js
// Public read endpoint: fetch a single contact row by slug, returning only
// the columns client-facing pages actually display. Service role does the
// lookup — no anon Supabase key required.
//
// Replaces direct /rest/v1/contacts?slug=eq.X reads from client templates
// (checkout, proposal, onboarding, report, entity-audit, endorsements,
// diagnosis, action-plan, progress, router, campaign-summary). Moving those
// reads behind this endpoint lets us drop the wide `qual=true` anon SELECT
// policy on contacts, closing the full-table enumeration path.
//
// Request:   GET /api/public-contact?slug=<slug>
// Response:  200 { contact: {...safe columns...} }
//            404 { error: "contact not found" }

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');

// Everything client-facing templates currently read. No internal-only fields:
// no drive_folder_id, no stripe_customer_id, no lost reason, no raw JSONB
// internal fields, no server timestamps beyond campaign_start.
var SAFE_COLUMNS = [
  'id',
  'slug',
  'first_name',
  'last_name',
  'credentials',
  'email',
  'phone',
  'practice_name',
  'legal_business_name',
  'website_url',
  'practice_address_line1',
  'practice_address_line2',
  'city',
  'state_province',
  'postal_code',
  'country',
  'timezone',
  'npi_number',
  'team_size',
  'service_delivery',
  'campaign_type',
  'campaign_start',
  'campaign_end',
  'plan_type',
  'plan_tier',
  'billing_cadence',
  'plan_amount_cents',
  'status',
  'audit_tier',
  'agreement_signed',
  'agreement_signed_at',
  'checkout_options',
  'platforms_to_omit'
].join(',');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  var slug = String(req.query.slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'valid slug required' });
  }

  var contact;
  try {
    contact = await sb.one('contacts?slug=eq.' + encodeURIComponent(slug) + '&select=' + SAFE_COLUMNS + '&limit=1');
  } catch (e) {
    await monitor.logError('public-contact', e, { client_slug: slug, detail: { stage: 'contact_lookup' } });
    return res.status(500).json({ error: 'lookup failed' });
  }
  if (!contact) return res.status(404).json({ error: 'contact not found' });

  // Minor cache so repeat-render pages don't thrash the DB. 30s is short
  // enough that pricing/plan changes propagate quickly.
  res.setHeader('Cache-Control', 'public, max-age=30');
  return res.status(200).json({ contact: contact });
};

module.exports.SAFE_COLUMNS = SAFE_COLUMNS;
