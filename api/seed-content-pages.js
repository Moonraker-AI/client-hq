/**
 * /api/seed-content-pages.js
 *
 * Seeds content_pages records for a client based on their tracked keywords,
 * bio materials, and standard page types (homepage, location, FAQ).
 * Also creates corresponding deliverables and links them via content_page_id.
 *
 * Idempotent: skips content_pages that already exist (matched by contact_id + page_type + tracked_keyword_id).
 *
 * POST body: { contact_id }
 *
 * Creates:
 *   - 1 homepage content_page (linked to entity audit if exists)
 *   - 1 service content_page per active tracked keyword
 *   - 1 location content_page (if client has city/state)
 *   - 1 FAQ content_page
 *   - 1 bio content_page per bio_material record
 *   - Corresponding deliverables for each (surge_page, target_page, etc.)
 */

var sb = require('./_lib/supabase');

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var contactId = req.body && req.body.contact_id;
  if (!contactId) return res.status(400).json({ error: 'contact_id required' });

  // Optional: seed only specific page types
  // 'all' (default), 'service' (keywords only), 'bio' (bio pages only)
  var seedType = (req.body && req.body.seed_type) || 'all';

  var headers = sb.headers();
  var writeHeaders = sb.headers('return=representation');

  try {
    // 1. Fetch all needed data in parallel
    var results = await Promise.all([
      fetch(sb.url() + '/rest/v1/contacts?id=eq.' + contactId + '&limit=1', { headers: headers }).then(r => r.json()),
      fetch(sb.url() + '/rest/v1/tracked_keywords?contact_id=eq.' + contactId + '&active=eq.true&order=priority,keyword', { headers: headers }).then(r => r.json()),
      fetch(sb.url() + '/rest/v1/bio_materials?contact_id=eq.' + contactId + '&order=sort_order,is_primary.desc', { headers: headers }).then(r => r.json()),
      fetch(sb.url() + '/rest/v1/content_pages?contact_id=eq.' + contactId, { headers: headers }).then(r => r.json()),
      fetch(sb.url() + '/rest/v1/deliverables?contact_id=eq.' + contactId, { headers: headers }).then(r => r.json()),
      fetch(sb.url() + '/rest/v1/entity_audits?contact_id=eq.' + contactId + '&order=created_at.desc&limit=1', { headers: headers }).then(r => r.json())
    ]);

    var contact = results[0] && results[0][0];
    var keywords = results[1] || [];
    var bios = results[2] || [];
    var existingPages = results[3] || [];
    var existingDels = results[4] || [];
    var entityAudit = results[5] && results[5][0];

    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    var slug = contact.slug;
    var created = { content_pages: 0, deliverables: 0, linked: 0 };

    // Helper: check if a content_page already exists
    function pageExists(type, keywordId, bioId) {
      return existingPages.some(function(p) {
        if (p.page_type !== type) return false;
        if (keywordId) return p.tracked_keyword_id === keywordId;
        if (bioId) return p.bio_material_id === bioId;
        return true; // For homepage/faq/location, match on type alone
      });
    }

    // Helper: find existing deliverable
    function findDel(type, titleContains) {
      return existingDels.find(function(d) {
        if (d.deliverable_type !== type) return false;
        if (titleContains) return d.title && d.title.indexOf(titleContains) !== -1;
        return true;
      });
    }

    // Helper: create a content_page and return it
    async function createPage(data) {
      var resp = await fetch(sb.url() + '/rest/v1/content_pages', {
        method: 'POST', headers: writeHeaders, body: JSON.stringify(data)
      });
      var result = await resp.json();
      var page = Array.isArray(result) ? result[0] : result;
      if (page && page.id) {
        created.content_pages++;
        existingPages.push(page); // Track for dedup
      }
      return page;
    }

    // Helper: create a deliverable linked to a content_page
    async function createDel(data) {
      var resp = await fetch(sb.url() + '/rest/v1/deliverables', {
        method: 'POST', headers: writeHeaders, body: JSON.stringify(data)
      });
      var result = await resp.json();
      var del = Array.isArray(result) ? result[0] : result;
      if (del && del.id) created.deliverables++;
      return del;
    }

    // Helper: link an existing deliverable to a content_page
    async function linkDel(delId, cpId) {
      await fetch(sb.url() + '/rest/v1/deliverables?id=eq.' + delId, {
        method: 'PATCH',
        headers: Object.assign({}, writeHeaders, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ content_page_id: cpId })
      });
      created.linked++;
    }

    // Helper: slugify a keyword
    function slugify(str) {
      return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    // ── HOMEPAGE ──
    if ((seedType === 'all' || seedType === 'service') && !pageExists('homepage', null, null)) {
      var hp = await createPage({
        contact_id: contactId,
        client_slug: slug,
        page_type: 'homepage',
        page_name: 'Homepage',
        page_slug: 'homepage',
        entity_audit_id: entityAudit ? entityAudit.id : null,
        status: entityAudit && entityAudit.surge_data ? 'audit_loaded' : 'pending_audit'
      });
      if (hp && hp.id) {
        // Link to existing surge_entity deliverable
        var entityDel = findDel('surge_entity', null);
        if (entityDel) await linkDel(entityDel.id, hp.id);
      }
    }

    // ── SERVICE PAGES (one per tracked keyword) ──
    if (seedType === 'all' || seedType === 'service')
    for (var i = 0; i < keywords.length; i++) {
      var kw = keywords[i];
      if (pageExists('service', kw.id, null)) continue;

      var sp = await createPage({
        contact_id: contactId,
        client_slug: slug,
        page_type: 'service',
        page_name: kw.keyword,
        page_slug: slugify(kw.keyword),
        tracked_keyword_id: kw.id,
        target_keyword: kw.keyword,
        status: 'pending_audit'
      });

      if (sp && sp.id) {
        // Create surge_page deliverable
        var existSurge = findDel('surge_page', kw.keyword);
        if (existSurge) {
          await linkDel(existSurge.id, sp.id);
        } else {
          await createDel({
            contact_id: contactId,
            deliverable_type: 'surge_page',
            title: 'Surge Page Audit - ' + kw.keyword,
            status: 'not_started',
            notes: 'Target keyword: ' + kw.keyword,
            content_page_id: sp.id
          });
        }

        // Create target_page deliverable
        var existTarget = findDel('target_page', kw.keyword);
        if (existTarget) {
          await linkDel(existTarget.id, sp.id);
        } else {
          await createDel({
            contact_id: contactId,
            deliverable_type: 'target_page',
            title: 'Target Page - ' + kw.keyword,
            status: 'not_started',
            notes: kw.target_page ? 'Existing page: ' + kw.target_page : 'New page to be created',
            content_page_id: sp.id
          });
        }
      }
    }

    // ── LOCATION PAGE ──
    if ((seedType === 'all' || seedType === 'service') && contact.city && contact.campaign_type !== 'national') {
      if (!pageExists('location', null, null)) {
        var locName = contact.city + (contact.state_province ? ', ' + contact.state_province : '');
        var lp = await createPage({
          contact_id: contactId,
          client_slug: slug,
          page_type: 'location',
          page_name: 'Location - ' + locName,
          page_slug: 'location-' + slugify(contact.city),
          status: 'pending_audit'
        });
        if (lp && lp.id) {
          var existLoc = findDel('location_page', null);
          if (existLoc) {
            await linkDel(existLoc.id, lp.id);
          } else {
            await createDel({
              contact_id: contactId,
              deliverable_type: 'location_page',
              title: 'Location Page - ' + locName,
              status: 'not_started',
              notes: 'Service area page for ' + locName,
              content_page_id: lp.id
            });
          }
        }
      }
    }

    // ── FAQ PAGE ──
    if ((seedType === 'all' || seedType === 'service') && !pageExists('faq', null, null)) {
      var faq = await createPage({
        contact_id: contactId,
        client_slug: slug,
        page_type: 'faq',
        page_name: 'General FAQ',
        page_slug: 'faq',
        status: 'pending_audit' // FAQ doesn't need Surge, but pending_audit is the starting state
      });
      if (faq && faq.id) {
        var existFaq = findDel('faq_page', null);
        if (existFaq) {
          await linkDel(existFaq.id, faq.id);
        } else {
          await createDel({
            contact_id: contactId,
            deliverable_type: 'faq_page',
            title: 'General FAQ Page',
            status: 'not_started',
            notes: 'Practice-level FAQ covering insurance, scheduling, intake, telehealth, privacy, and crisis info.',
            content_page_id: faq.id
          });
        }
      }
    }

    // ── BIO PAGES (one per bio_material) ──
    if (seedType === 'all' || seedType === 'bio')
    for (var b = 0; b < bios.length; b++) {
      var bio = bios[b];
      if (pageExists('bio', null, bio.id)) continue;

      var bioName = bio.therapist_name || 'Clinician';
      var bp = await createPage({
        contact_id: contactId,
        client_slug: slug,
        page_type: 'bio',
        page_name: 'Bio - ' + bioName,
        page_slug: 'bio-' + slugify(bioName),
        bio_material_id: bio.id,
        status: 'pending_audit'
      });

      if (bp && bp.id) {
        var existBio = findDel('bio_page', bioName);
        if (existBio) {
          await linkDel(existBio.id, bp.id);
        } else {
          await createDel({
            contact_id: contactId,
            deliverable_type: 'bio_page',
            title: 'Bio Page - ' + bioName,
            status: 'not_started',
            notes: 'Bio page for ' + bioName + (bio.therapist_credentials ? ', ' + bio.therapist_credentials : ''),
            content_page_id: bp.id
          });
        }
      }
    }

    return res.status(200).json({
      success: true,
      created: created,
      summary: {
        content_pages_created: created.content_pages,
        deliverables_created: created.deliverables,
        deliverables_linked: created.linked,
        keywords_processed: keywords.length,
        bios_processed: bios.length
      }
    });

  } catch (err) {
    console.error('seed-content-pages error:', err);
    return res.status(500).json({ error: err.message });
  }
};
