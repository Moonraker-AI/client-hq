/**
 * /api/_lib/schema-builder.js
 *
 * Takes Surge-recommended schema types + a complete client data fan-out and
 * returns fully-populated JSON-LD blocks ready to be saved to
 * content_pages.schema_jsonb. The render layer emits these as
 * <script type="application/ld+json"> blocks in <head>.
 *
 * Why this exists:
 *   Surge's Implementation Blueprint Phase 6 contains schema templates with
 *   placeholders ([Your Postal Code], [path-to-your-logo], etc.). We have
 *   all the real data on file. This helper assembles complete, deterministic
 *   schema — Pagemaster never asks Claude to invent contact data.
 *
 * Inputs:
 *   client = {
 *     contact, practice, bios, social_platforms, directory_listings,
 *     entity_audit, design_spec, tracked_keywords
 *   }
 *   schema_recommendations = the parsed surge_parser output:
 *     { blocks: [ { heading, raw_jsonld, parsed: {...} } ], notes }
 *   page = the content_pages row (target_url, page_type, target_keyword, page_slug)
 *
 * Output:
 *   Array of JSON-LD blocks, each a plain object suitable for JSON.stringify
 *   into a <script> tag. Always includes Organization + LocalBusiness +
 *   primary Person (founder). Adds others (FAQPage, Service per modality,
 *   AggregateRating, VideoObject) when warranted by Surge recommendations
 *   and available data.
 *
 * Coverage rules:
 *   - sameAs is the kitchen sink: every social URL, every directory listing,
 *     every Psychology Today / Yelp profile we have. No deduplication beyond
 *     URL exact-match. AI engines benefit from broad sameAs corroboration.
 *   - All Organization-typed blocks share the canonical @id
 *     "<site_url>#organization" so AI systems treat them as one entity.
 *   - Person blocks for clinicians use "<site_url>#<bio_slug>" as @id, link
 *     back to the org via worksFor.
 *   - knowsAbout pulls from practice_details.specialties + tracked_keywords.
 *   - Address always full and structured.
 *   - Phone normalized to E.164 where possible.
 */

var PRIMARY_TYPE_FOR_THERAPY = 'MedicalBusiness';

/**
 * Main entry point.
 */
function build(client, schemaRecs, page) {
  var contact = client.contact || {};
  var practice = client.practice || {};
  var bios = client.bios || [];
  var socials = client.social_platforms || [];
  var directories = client.directory_listings || [];
  var keywords = client.tracked_keywords || [];

  var siteUrl = normalizeUrl(contact.website_url) || ('https://' + (contact.slug || 'unknown') + '.com');
  var orgId = siteUrl.replace(/\/$/, '') + '#organization';
  var pageUrl = page && page.target_url ? page.target_url
                  : siteUrl.replace(/\/$/, '') + '/' + (page && page.page_slug || '');

  var blocks = [];

  // 1. Always: primary Organization / MedicalBusiness block. This is the
  //    entity anchor — every other block links back to it via @id or worksFor.
  blocks.push(buildOrganization(orgId, siteUrl, contact, practice, bios, socials, directories, keywords));

  // 2. Always: founder Person block (if we have one).
  var founder = bios.find(function(b) { return b.is_primary; }) || bios[0];
  if (founder) {
    blocks.push(buildPerson(founder, contact, siteUrl, orgId));
  }

  // 3. Other clinicians (employees) — separate Person blocks if more than
  //    just the founder.
  bios.forEach(function(bio) {
    if (founder && bio.id === founder.id) return;
    blocks.push(buildPerson(bio, contact, siteUrl, orgId));
  });

  // 4. AggregateRating — only when we have real review data
  if (contact.current_google_rating && contact.current_review_count > 0) {
    blocks.push(buildAggregateRating(orgId, contact));
  }

  // 5. FAQPage — when Surge recommended one and we have FAQ content on the
  //    content_page (set by Pagemaster in cp.faqs jsonb)
  if (recommendsType(schemaRecs, 'FAQPage') && page && page.faqs && page.faqs.length > 0) {
    blocks.push(buildFaqPage(page.faqs));
  }

  // 6. Service blocks — one per modality when Surge recommended Service
  //    schema or when practice_details.modalities is non-empty
  if (recommendsType(schemaRecs, 'Service') && practice.modalities && practice.modalities.length > 0) {
    practice.modalities.forEach(function(mod) {
      blocks.push(buildService(mod, contact, orgId, siteUrl));
    });
  }

  // 7. WebPage block tying the current page to the org
  blocks.push(buildWebPage(pageUrl, page, orgId, contact));

  // 8. BreadcrumbList for non-homepage pages
  if (page && page.page_type && page.page_type !== 'homepage') {
    blocks.push(buildBreadcrumb(siteUrl, pageUrl, page));
  }

  return blocks;
}

// ────────────────────────────────────────────────────────────────────
// Builders
// ────────────────────────────────────────────────────────────────────

function buildOrganization(orgId, siteUrl, contact, practice, bios, socials, directories, keywords) {
  var sameAs = collectSameAs(contact, socials, directories);
  var knowsAbout = collectKnowsAbout(practice, keywords);
  var founder = bios.find(function(b) { return b.is_primary; }) || bios[0];

  var block = {
    '@context': 'https://schema.org',
    '@type': PRIMARY_TYPE_FOR_THERAPY,
    '@id': orgId,
    name: contact.practice_name || contact.legal_business_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim(),
    url: siteUrl,
    description: practice.differentiators || practice.ideal_client || (contact.practice_name + ' provides therapy services.')
  };

  if (contact.legal_business_name && contact.legal_business_name !== block.name) {
    block.legalName = contact.legal_business_name;
  }
  if (contact.logo_url) block.logo = contact.logo_url;
  if (contact.phone) block.telephone = normalizePhone(contact.phone);
  if (contact.email) block.email = contact.email;

  var addr = buildPostalAddress(contact);
  if (addr) block.address = addr;

  if (contact.gbp_url) block.hasMap = contact.gbp_url;

  // areaServed: licensed states + city/state for local
  var areas = [];
  if (practice.licensed_states && practice.licensed_states.length > 0) {
    practice.licensed_states.forEach(function(s) {
      areas.push({ '@type': 'State', name: s });
    });
  } else if (contact.state_province) {
    areas.push({ '@type': 'State', name: contact.state_province });
  }
  if (areas.length === 1) block.areaServed = areas[0];
  else if (areas.length > 1) block.areaServed = areas;

  if (sameAs.length > 0) block.sameAs = sameAs;
  if (knowsAbout.length > 0) block.knowsAbout = knowsAbout;

  if (founder) {
    block.founder = {
      '@type': 'Person',
      name: founder.therapist_name,
      honorificSuffix: founder.therapist_credentials || undefined,
      jobTitle: founder.therapist_credentials || undefined,
      url: founder.page_url || undefined
    };
  }

  // Hours
  if (practice.hours_of_operation && typeof practice.hours_of_operation === 'object') {
    var openingHours = formatHours(practice.hours_of_operation);
    if (openingHours.length > 0) block.openingHoursSpecification = openingHours;
  }

  if (practice.booking_url) {
    block.potentialAction = {
      '@type': 'ReserveAction',
      target: practice.booking_url,
      result: { '@type': 'Reservation', name: 'Book a free consultation' }
    };
  }

  return stripUndefined(block);
}

function buildPerson(bio, contact, siteUrl, orgId) {
  var personId = siteUrl.replace(/\/$/, '') + '#person-' + (bio.slug || bio.id);
  var block = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    '@id': personId,
    name: bio.therapist_name,
    honorificSuffix: bio.therapist_credentials || undefined,
    jobTitle: bio.therapist_credentials || undefined,
    description: bio.professional_bio || undefined,
    image: bio.headshot_url || undefined,
    email: bio.email || undefined,
    url: bio.page_url || undefined,
    worksFor: { '@id': orgId }
  };

  // alumniOf from education_details
  var alumni = collectAlumniOf(bio);
  if (alumni.length > 0) block.alumniOf = alumni.length === 1 ? alumni[0] : alumni;

  // hasCredential from licenses + certifications
  var creds = collectCredentials(bio);
  if (creds.length > 0) block.hasCredential = creds.length === 1 ? creds[0] : creds;

  // memberOf from associations
  var memberships = collectMemberships(bio);
  if (memberships.length > 0) block.memberOf = memberships.length === 1 ? memberships[0] : memberships;

  return stripUndefined(block);
}

function buildAggregateRating(orgId, contact) {
  return {
    '@context': 'https://schema.org',
    '@type': 'AggregateRating',
    itemReviewed: { '@id': orgId },
    ratingValue: contact.current_google_rating.toFixed(1),
    bestRating: '5',
    worstRating: '1',
    ratingCount: contact.current_review_count,
    reviewCount: contact.current_review_count
  };
}

function buildFaqPage(faqs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.filter(function(f) { return f.question && f.answer; }).map(function(f) {
      return {
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer }
      };
    })
  };
}

function buildService(modalityName, contact, orgId, siteUrl) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: modalityName,
    name: modalityName + ' — ' + (contact.practice_name || ''),
    provider: { '@id': orgId },
    areaServed: contact.state_province || contact.country || undefined,
    url: siteUrl
  };
}

function buildWebPage(pageUrl, page, orgId, contact) {
  var block = {
    '@context': 'https://schema.org',
    '@type': page && page.page_type === 'service' ? 'MedicalWebPage' : 'WebPage',
    '@id': pageUrl + '#webpage',
    url: pageUrl,
    name: page && page.page_name ? page.page_name : (contact.practice_name || ''),
    isPartOf: { '@id': orgId },
    about: { '@id': orgId },
    primaryImageOfPage: contact.logo_url ? { '@type': 'ImageObject', url: contact.logo_url } : undefined,
    inLanguage: 'en-US'
  };
  return stripUndefined(block);
}

function buildBreadcrumb(siteUrl, pageUrl, page) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
      { '@type': 'ListItem', position: 2, name: page.page_name || page.target_keyword || page.page_slug, item: pageUrl }
    ]
  };
}

function buildPostalAddress(contact) {
  if (!contact.practice_address_line1 && !contact.city) return null;
  var addr = {
    '@type': 'PostalAddress',
    streetAddress: [contact.practice_address_line1, contact.practice_address_line2].filter(Boolean).join(', ') || undefined,
    addressLocality: contact.city || undefined,
    addressRegion: contact.state_province || undefined,
    postalCode: contact.postal_code || undefined,
    addressCountry: contact.country || 'US'
  };
  return stripUndefined(addr);
}

// ────────────────────────────────────────────────────────────────────
// Collectors
// ────────────────────────────────────────────────────────────────────

function collectSameAs(contact, socials, directories) {
  var urls = [];
  // Explicit columns on contacts
  ['psychology_today_url', 'facebook_url', 'linkedin_url', 'instagram_url',
   'youtube_url', 'tiktok_url', 'quora_url', 'pinterest_url', 'x_url',
   'gbp_url'].forEach(function(field) {
    var u = normalizeUrl(contact[field]);
    if (u) urls.push(u);
  });
  // social_platforms table
  socials.forEach(function(s) {
    var u = normalizeUrl(s.profile_url);
    if (u) urls.push(u);
  });
  // directory_listings table — every active or live listing
  directories.forEach(function(d) {
    if (d.status && d.status !== 'live' && d.status !== 'active' && d.status !== 'verified') return;
    var u = normalizeUrl(d.profile_url);
    if (u) urls.push(u);
  });
  // Dedup
  var seen = {};
  return urls.filter(function(u) { if (seen[u]) return false; seen[u] = true; return true; });
}

function collectKnowsAbout(practice, keywords) {
  var terms = [];
  if (practice.specialties) practice.specialties.forEach(function(s) { if (s) terms.push(s); });
  if (practice.modalities) practice.modalities.forEach(function(m) { if (m) terms.push(m); });
  if (practice.populations) practice.populations.forEach(function(p) { if (p) terms.push(p); });
  // Top-priority active keywords
  if (keywords && keywords.length > 0) {
    keywords.filter(function(k) { return k.active && !k.retired_at; })
      .slice(0, 20)
      .forEach(function(k) { if (k.keyword) terms.push(k.keyword); });
  }
  // Dedup case-insensitively, keep original casing of first occurrence
  var seen = {};
  return terms.filter(function(t) {
    var k = t.toLowerCase().trim();
    if (!k || seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

function collectAlumniOf(bio) {
  var out = [];
  var ed = bio.education_details;
  if (Array.isArray(ed)) {
    ed.forEach(function(e) {
      if (e && (e.school || e.institution)) {
        out.push({ '@type': 'EducationalOrganization', name: e.school || e.institution });
      }
    });
  }
  return out;
}

function collectCredentials(bio) {
  var out = [];
  var lic = bio.license_details;
  if (Array.isArray(lic)) {
    lic.forEach(function(l) {
      if (l && (l.license_type || l.title)) {
        out.push({
          '@type': 'EducationalOccupationalCredential',
          name: l.license_type || l.title,
          credentialCategory: 'license',
          recognizedBy: l.issuing_body || l.state ? { '@type': 'Organization', name: l.issuing_body || (l.state + ' licensing board') } : undefined
        });
      }
    });
  }
  var certs = bio.certification_details;
  if (Array.isArray(certs)) {
    certs.forEach(function(c) {
      if (c && (c.name || c.title)) {
        out.push({
          '@type': 'EducationalOccupationalCredential',
          name: c.name || c.title,
          credentialCategory: 'certification',
          recognizedBy: c.issuer ? { '@type': 'Organization', name: c.issuer } : undefined
        });
      }
    });
  }
  return out.map(stripUndefined);
}

function collectMemberships(bio) {
  var out = [];
  var assoc = bio.association_details;
  if (Array.isArray(assoc)) {
    assoc.forEach(function(a) {
      if (a && (a.name || a.organization)) {
        out.push({ '@type': 'Organization', name: a.name || a.organization });
      }
    });
  }
  return out;
}

function formatHours(hoursJson) {
  // Accept a few shapes: { monday: '9-5', ...}, { mon: {open, close}, ...}, etc.
  // Output OpeningHoursSpecification per day.
  var dayMap = { mon: 'Monday', monday: 'Monday', tue: 'Tuesday', tuesday: 'Tuesday',
    wed: 'Wednesday', wednesday: 'Wednesday', thu: 'Thursday', thursday: 'Thursday',
    fri: 'Friday', friday: 'Friday', sat: 'Saturday', saturday: 'Saturday',
    sun: 'Sunday', sunday: 'Sunday' };
  var out = [];
  Object.keys(hoursJson).forEach(function(key) {
    var dayName = dayMap[key.toLowerCase()];
    if (!dayName) return;
    var v = hoursJson[key];
    var opens, closes;
    if (typeof v === 'object' && v !== null) {
      opens = v.open || v.opens;
      closes = v.close || v.closes;
    } else if (typeof v === 'string' && v.indexOf('-') > 0) {
      var parts = v.split('-').map(function(p) { return p.trim(); });
      opens = parts[0]; closes = parts[1];
    }
    if (opens && closes && /closed/i.test(opens) === false) {
      out.push({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: dayName,
        opens: normalizeTime(opens),
        closes: normalizeTime(closes)
      });
    }
  });
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────

function recommendsType(schemaRecs, type) {
  if (!schemaRecs || !schemaRecs.blocks) return false;
  return schemaRecs.blocks.some(function(b) {
    return b.parsed && (b.parsed['@type'] === type ||
      (Array.isArray(b.parsed['@type']) && b.parsed['@type'].indexOf(type) !== -1));
  });
}

function normalizeUrl(u) {
  if (!u || typeof u !== 'string') return null;
  u = u.trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  // Drop trailing whitespace, common query-string noise (utm)
  return u;
}

function normalizePhone(p) {
  if (!p) return p;
  var digits = ('' + p).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return digits;
}

function normalizeTime(t) {
  if (!t) return t;
  // "9am" -> "09:00", "5:30pm" -> "17:30", "17:00" passes through
  var s = ('' + t).trim().toLowerCase();
  var ampm = null;
  if (s.endsWith('am')) { ampm = 'am'; s = s.slice(0, -2).trim(); }
  else if (s.endsWith('pm')) { ampm = 'pm'; s = s.slice(0, -2).trim(); }
  var parts = s.split(':');
  var h = parseInt(parts[0], 10);
  var m = parts[1] ? parseInt(parts[1], 10) : 0;
  if (isNaN(h)) return t;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return (h < 10 ? '0' + h : '' + h) + ':' + (m < 10 ? '0' + m : '' + m);
}

function stripUndefined(obj) {
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  if (obj === null || typeof obj !== 'object') return obj;
  var out = {};
  Object.keys(obj).forEach(function(k) {
    var v = obj[k];
    if (v === undefined || v === null) return;
    if (typeof v === 'object') {
      var nested = stripUndefined(v);
      if (Array.isArray(nested) && nested.length === 0) return;
      if (typeof nested === 'object' && Object.keys(nested).length === 0) return;
      out[k] = nested;
    } else {
      out[k] = v;
    }
  });
  return out;
}

/**
 * Inspects a built block array for placeholder values. Returns array of
 * issues — useful for admin UI to warn about incomplete schema.
 */
function detectPlaceholders(blocks) {
  var issues = [];
  var jsonStr = JSON.stringify(blocks);
  var patterns = [
    /\[Your [^\]]+\]/g,
    /\[your-[^\]]+\]/g,
    /\[path-to-[^\]]+\]/g,
    /\[YOUR-[^\]]+\]/g,
    /\[YYYY-MM-DD\]/g,
    /\[PT_M_S\]/g,
    /\[insert [^\]]+\]/gi
  ];
  patterns.forEach(function(p) {
    var matches = jsonStr.match(p);
    if (matches) matches.forEach(function(m) { issues.push(m); });
  });
  return Array.from(new Set(issues));
}

module.exports = {
  build: build,
  detectPlaceholders: detectPlaceholders,
  // exposed for tests
  _collectSameAs: collectSameAs,
  _collectKnowsAbout: collectKnowsAbout,
  _normalizePhone: normalizePhone,
  _normalizeTime: normalizeTime
};
