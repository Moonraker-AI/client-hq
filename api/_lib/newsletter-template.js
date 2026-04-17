// api/_lib/newsletter-template.js
// Newsletter email template builder for Moonraker weekly newsletter.
// Uses the same dark navy header/footer pattern as all Moonraker emails.

var ASSETS_BASE = 'https://clients.moonraker.ai/assets';
var LOGO_URL = ASSETS_BASE + '/logo.png';
var PARTNER_LOGOS_URL = ASSETS_BASE + '/newsletter/partner-logos.png';
var GOOGLE_RATING_URL = ASSETS_BASE + '/newsletter/google-rating.png';
var GOOGLE_PARTNER_URL = ASSETS_BASE + '/newsletter/google-partner.png';
var GOOGLE_LOCAL_GUIDES_URL = ASSETS_BASE + '/newsletter/google-local-guides.png';
var SCOTT_SIGNATURE_URL = ASSETS_BASE + '/newsletter/scott-signature.png';
var UNSUBSCRIBE_BASE = 'https://clients.moonraker.ai/api/newsletter-unsubscribe';

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

var C = {
  navy: '#141C3A', white: '#FFFFFF', bg: '#F5F5F0', primary: '#00D47E',
  heading: '#1E2A5E', body: '#333F70', muted: '#6B7599', border: '#E2E8F0',
  subtleBg: '#F0FAF5', lightGreen: '#DDF8F2'
};

var F = {
  heading: "Outfit, 'Trebuchet MS', Arial, sans-serif",
  body: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"
};

function divider() {
  return '<tr><td style="padding:0;"><table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
    '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table></td></tr>';
}

function storyBlock(story, index) {
  var num = index + 1;
  var imageHtml = '';
  if (story.image_url) {
    imageHtml = '<tr><td style="padding:0 0 16px;">' +
      '<img src="' + esc(story.image_url) + '" alt="' + esc(story.image_alt || story.headline) + '" ' +
      'width="536" style="display:block;width:100%;max-width:536px;height:auto;border-radius:8px;" />' +
      '</td></tr>';
  }

  var actionHtml = '';
  if (story.action_items || story.actions) {
    var items = story.action_items || story.actions;
    if (typeof items === 'string') {
      var lines = items.split('\n').filter(function(l) { return l.trim(); });
      actionHtml = lines.length > 1
        ? '<div style="margin:0;padding:0;">' + lines.map(function(item) {
            return '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.6;margin:0 0 6px;">\u{1F449} ' + item + '</p>';
          }).join('') + '</div>'
        : '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0;">' + items + '</p>';
    } else if (Array.isArray(items)) {
      actionHtml = '<div style="margin:0;padding:0;">' + items.map(function(item) {
        return '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.6;margin:0 0 6px;">\u{1F449} ' + item + '</p>';
      }).join('') + '</div>';
    }
  }

  return '<tr><td style="padding:0 0 8px;"><table cellpadding="0" cellspacing="0" border="0" width="100%">' +
    imageHtml +
    '<tr><td style="padding:0 0 12px;"><h2 style="font-family:' + F.heading + ';font-size:22px;font-weight:700;color:' + C.heading + ';margin:0;line-height:1.3;">' +
      num + '. ' + (story.headline || '') + '</h2></td></tr>' +
    '<tr><td style="padding:0 0 16px;"><div style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;">' +
      (story.body || '') + '</div></td></tr>' +
    (actionHtml ? '<tr><td style="padding:14px 20px;background:' + C.subtleBg + ';border-left:3px solid ' + C.primary + ';border-radius:0 8px 8px 0;">' +
      '<p style="font-family:' + F.body + ';font-size:15px;font-weight:600;color:' + C.heading + ';margin:0 0 8px;">Action:</p>' +
      actionHtml + '</td></tr>' : '') +
    '</table></td></tr>' +
    '<tr><td style="padding:16px 0;"><table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table></td></tr>';
}

function quickWinsBlock(items) {
  if (!items || !items.length) return '';
  return '<tr><td style="padding:0 0 8px;">' +
    '<h2 style="font-family:' + F.heading + ';font-size:22px;font-weight:700;color:' + C.heading + ';margin:0 0 14px;">\u2705 Quick Wins for This Week</h2>' +
    '<ul style="margin:0;padding:0 0 0 20px;">' + items.map(function(item) {
      return '<li style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0 0 6px;">' + item + '</li>';
    }).join('') + '</ul></td></tr>' +
    '<tr><td style="padding:16px 0;"><table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table></td></tr>';
}

function spotlightBlock(spotlight) {
  var headline = '\u{1F680} Spotlight: Engage (Moonraker\'s New AI Project)';
  var body = '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0 0 12px;">' +
    '<strong>Engage is now ready for beta testers.</strong> We\'re looking for therapists who want to try a HIPAA-compliant AI chatbot built specifically for therapy practices. ' +
    '<strong>Engage</strong> handles FAQs, helps potential clients book consultations, and keeps your practice responsive around the clock, even when you\'re in session.</p>' +
    '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0 0 12px;">' +
    'This beta is not yet HIPAA-compliant, so no client health information will be processed during testing. What we\'re looking for is your feedback on the experience.</p>';
  var cta = '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.heading + ';line-height:1.7;margin:0;font-weight:600;">' +
    '\u{1F449} <strong>Interested in being one of the first testers?</strong> Just reply to this email with "ENGAGE"</p>';

  if (spotlight && spotlight.headline) {
    headline = spotlight.headline;
    body = '<div style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;">' + (spotlight.body || '') + '</div>';
    cta = spotlight.cta_text ? '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.heading + ';line-height:1.7;margin:12px 0 0;font-weight:600;">' + spotlight.cta_text + '</p>' : '';
  }

  return '<tr><td style="padding:0 0 8px;"><table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.lightGreen + ';border-radius:8px;">' +
    '<tr><td style="padding:24px;">' +
      '<h2 style="font-family:' + F.heading + ';font-size:22px;font-weight:700;color:' + C.heading + ';margin:0 0 14px;">' + headline + '</h2>' +
      body + cta +
    '</td></tr></table></td></tr>' +
    '<tr><td style="padding:16px 0;"><table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table></td></tr>';
}

function finalThoughtsBlock(text) {
  if (!text) return '';
  return '<tr><td style="padding:0 0 24px;">' +
    '<h2 style="font-family:' + F.heading + ';font-size:22px;font-weight:700;color:' + C.heading + ';margin:0 0 14px;">\u{1F64F} Final Thoughts</h2>' +
    '<div style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;">' + text + '</div>' +
  '</td></tr>';
}

function signatureBlock() {
  return '<tr><td style="padding:8px 0 0;">' +
    '<p style="font-family:' + F.body + ';font-size:15px;font-style:italic;color:' + C.body + ';line-height:1.7;margin:0 0 4px;">To your growth and success,</p>' +
    '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.heading + ';margin:0 0 8px;line-height:1.5;">' +
      '<strong>Scott Pope</strong> - Director of Growth &amp; Operations, ' +
      '<a href="https://moonraker.ai" style="color:' + C.primary + ';text-decoration:none;">Moonraker.AI</a></p>' +
    '<img src="' + SCOTT_SIGNATURE_URL + '" alt="Scott Pope" width="160" style="display:block;width:160px;height:auto;" />' +
  '</td></tr>';
}

// Migration notice shown during the warmup ramp only. Auto-disappears when warmup
// completes (build() is called with warmupActive=false).
function migrationNoticeBlock() {
  return '<tr><td style="padding:0 0 20px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.lightGreen + ';border:1px solid ' + C.primary + ';border-radius:8px;">' +
      '<tr><td style="padding:14px 18px;">' +
        '<p style="font-family:' + F.body + ';font-size:13.5px;color:' + C.body + ';line-height:1.6;margin:0;">' +
          '<strong style="color:' + C.heading + ';font-family:' + F.body + ';">A quick note.</strong> ' +
          'You\'re receiving this from our new newsletter system. If a copy also arrives from our old platform, that\'s expected during the transition. ' +
          'To make sure future issues don\'t land in spam, please mark this email "Not spam" and add ' +
          '<strong style="color:' + C.heading + ';font-family:' + F.body + ';">newsletter@newsletter.moonraker.ai</strong> to your contacts. ' +
          'Thanks for bearing with us.' +
        '</p>' +
      '</td></tr>' +
    '</table>' +
  '</td></tr>';
}

function build(newsletter, subscriberId, opts) {
  opts = opts || {};
  var content = newsletter.content || {};
  var stories = content.stories || [];
  var quickWins = content.quick_wins || [];
  var finalThoughts = content.final_thoughts || '';
  var spotlight = content.spotlight || null;
  var year = new Date().getFullYear();
  var unsubUrl = UNSUBSCRIBE_BASE + (subscriberId ? '?sid=' + subscriberId : '');
  var storiesHtml = stories.map(function(s, i) { return storyBlock(s, i); }).join('');
  var warmupActive = !!opts.warmupActive;

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' +
    '<style>@import url("https://fonts.googleapis.com/css2?family=Outfit:wght@700&family=Inter:wght@400;500;600&display=swap");' +
    'body{margin:0;padding:0;}img{border:0;outline:none;text-decoration:none;}' +
    '@media only screen and (max-width:620px){.email-container{width:100%!important;}.email-body{padding:20px 16px!important;}.badge-cell{padding:4px 6px!important;}.badge-cell img{height:auto!important;max-height:40px!important;}}</style>' +
    '</head><body style="margin:0;padding:0;background:' + C.bg + ';font-family:' + F.body + ';">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.bg + ';">' +
    '<tr><td align="center" style="padding:24px 16px;">' +
    '<table class="email-container" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">' +

    // HEADER: Dark navy bar, logo left, label right
    '<tr><td style="background:' + C.navy + ';padding:18px 20px;border-radius:14px 14px 0 0;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
        '<td style="vertical-align:middle;"><img src="' + LOGO_URL + '" alt="Moonraker" height="34" style="display:block;" /></td>' +
        '<td style="text-align:right;vertical-align:middle;"><span style="color:' + C.white + ';font-family:' + F.body + ';font-size:12px;letter-spacing:0.03em;">Moonraker Newsletter #' + (newsletter.edition_number || '') + '</span></td>' +
      '</tr></table>' +
    '</td></tr>' +

    // BODY: White content area with side borders
    '<tr><td class="email-body" style="background:' + C.white + ';padding:32px;border-left:1px solid ' + C.border + ';border-right:1px solid ' + C.border + ';">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    (warmupActive ? migrationNoticeBlock() : '') +

    '<tr><td style="padding:0 0 20px;"><p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0;text-align:center;">' +
      'We know running a therapy practice is more than sessions. It\'s managing visibility, trust, and compliance in a digital-first world. ' +
      'At Moonraker, we\'re here to make that easier, so every week you\'ll get a short, practical update on SEO + AI trends that affect therapists across the U.S. and Canada.</p></td></tr>' +

    divider() +

    '<tr><td style="padding:24px 0;text-align:center;"><img src="' + PARTNER_LOGOS_URL + '" alt="Trusted by leading therapy business coaches" ' +
      'width="600" style="display:block;width:calc(100% + 32px);max-width:none;height:auto;margin:0 -16px;" /></td></tr>' +

    divider() +
    '<tr><td style="padding:12px 0 0;">&nbsp;</td></tr>' +

    storiesHtml +
    quickWinsBlock(quickWins) +
    (spotlight !== false ? spotlightBlock(spotlight) : '') +
    finalThoughtsBlock(finalThoughts) +
    signatureBlock() +

    // Google badges row (inside white body, above footer)
    '<tr><td style="padding:16px 0 0;"><table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table></td></tr>' +
    '<tr><td style="padding:20px 0 8px;text-align:center;">' +
      '<table cellpadding="0" cellspacing="0" border="0" align="center"><tr>' +
        '<td class="badge-cell" style="padding:0 16px;vertical-align:middle;"><img src="' + GOOGLE_RATING_URL + '" alt="Google Rating 4.9" height="40" style="display:inline-block;height:40px;width:auto;" /></td>' +
        '<td class="badge-cell" style="padding:0 16px;vertical-align:middle;"><img src="' + GOOGLE_LOCAL_GUIDES_URL + '" alt="Google Local Guides" height="40" style="display:inline-block;height:40px;width:auto;" /></td>' +
        '<td class="badge-cell" style="padding:0 16px;vertical-align:middle;"><img src="' + GOOGLE_PARTNER_URL + '" alt="Google Partner" height="40" style="display:inline-block;height:40px;width:auto;" /></td>' +
      '</tr></table>' +
    '</td></tr>' +

    '</table></td></tr>' +

    // FOOTER: Dark navy bar with copyright + unsubscribe (no badges)
    '<tr><td style="background:' + C.navy + ';padding:24px 32px;border-radius:0 0 14px 14px;text-align:center;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
      '<tr><td style="padding:0 0 8px;text-align:center;">' +
        '<p style="font-family:' + F.body + ';font-size:12px;color:rgba(232,245,239,.55);margin:0 0 4px;line-height:1.6;">&copy;' + year + ' <a href="https://moonraker.ai" style="color:rgba(232,245,239,.55);text-decoration:none;">Moonraker.AI</a></p>' +
        '<p style="font-family:' + F.body + ';font-size:12px;color:rgba(232,245,239,.35);margin:0;line-height:1.6;">119 Oliver St, Easthampton, MA 01027</p></td></tr>' +
      '<tr><td style="padding:8px 0 0;text-align:center;">' +
        '<p style="font-family:' + F.body + ';font-size:11px;color:rgba(232,245,239,.35);margin:0;line-height:1.6;">' +
          'You\'re receiving this because you attended one of our webinars, signed up for our services, or inquired about working with Moonraker. ' +
          'To unsubscribe, <a href="' + esc(unsubUrl) + '" style="color:rgba(232,245,239,.55);text-decoration:underline;">click here</a>.</p></td></tr>' +
      '</table></td></tr>' +

    '</table></td></tr></table></body></html>';
}

function buildBlog(newsletter) {
  var content = newsletter.content || {};
  var stories = content.stories || [];
  var quickWins = content.quick_wins || [];
  var finalThoughts = content.final_thoughts || '';

  var storiesHtml = stories.map(function(s, i) {
    var num = i + 1;
    var img = s.image_url ? '<img src="' + esc(s.image_url) + '" alt="' + esc(s.image_alt || s.headline) + '" style="width:100%;border-radius:8px;margin-bottom:1rem;" />' : '';
    var actionHtml = '';
    if (s.action_items || s.actions) {
      var raw = s.action_items || s.actions;
      var items = typeof raw === 'string' ? raw.split('\n').filter(function(l) { return l.trim(); }) : (raw || []);
      actionHtml = '<div class="action-box"><p><strong>Action:</strong></p><ul>' + items.map(function(item) { return '<li>' + item + '</li>'; }).join('') + '</ul></div>';
    }
    return '<article class="story">' + img + '<h2>' + num + '. ' + esc(s.headline) + '</h2><div class="story-body">' + (s.body || '') + '</div>' + actionHtml + '</article>';
  }).join('');

  var quickWinsHtml = quickWins.length ? '<section class="quick-wins"><h2>\u2705 Quick Wins for This Week</h2><ul>' + quickWins.map(function(w) { return '<li>' + w + '</li>'; }).join('') + '</ul></section>' : '';
  var finalHtml = finalThoughts ? '<section class="final-thoughts"><h2>\u{1F64F} Final Thoughts</h2><div>' + finalThoughts + '</div></section>' : '';

  return storiesHtml + quickWinsHtml + finalHtml +
    '<p class="signature">To your growth and success,<br><em>Scott Pope, Director of Growth &amp; Operations, Moonraker.AI</em></p>';
}

module.exports = { build: build, buildBlog: buildBlog, esc: esc, C: C, F: F };






