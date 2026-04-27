/**
 * /api/_lib/surge-parser.js
 *
 * Parses raw Surge audit output (markdown or JSON) and extracts:
 *   - rtpba: the Ready-to-Publish Best Answer content (markdown)
 *   - schema_recommendations: JSON-LD blocks from Phase 6 of the blueprint
 *   - variance_score / variance_label: top-level Surge score
 *   - structured_scores: STRUCTURED_SCORES JSON block (metrics + brand_datasets)
 *   - blueprint_phases: lightweight summary of Phase 1-8 of the implementation blueprint
 *   - cluster_synthesis: interlink + cross-page recommendations (when present)
 *
 * Surge output shape evolves over time. The parser handles three shapes:
 *   1. Pure JSON (legacy agent extraction format)
 *   2. Markdown with embedded JSON code blocks (the v3 shape — Anna's example)
 *   3. Mixed text + raw_text envelope (transitional shape)
 *
 * All extractors are best-effort. Returning null/empty for a field is fine —
 * Pagemaster degrades gracefully when fields are absent.
 */

var PARSER_VERSION = '1.0.0';

/**
 * Main entry point. Pass either:
 *   - a string (raw markdown or JSON text)
 *   - an object (already-parsed JSON or { raw_text: '...' } envelope)
 *
 * Returns { rtpba, schema_recommendations, variance_score, variance_label,
 *           structured_scores, blueprint_phases, cluster_synthesis,
 *           parser_version, parsed_at, source_shape }
 */
function parse(input) {
  var raw = '';
  var json = null;
  var sourceShape = 'unknown';

  if (typeof input === 'string') {
    raw = input;
    // Try parsing as JSON first
    try {
      json = JSON.parse(input);
      sourceShape = 'json';
      // If parsed JSON has raw_text, use that for markdown extraction
      if (json && json.raw_text) {
        raw = json.raw_text;
        sourceShape = 'mixed';
      }
    } catch (e) {
      sourceShape = 'markdown';
    }
  } else if (input && typeof input === 'object') {
    json = input;
    raw = input.raw_text || '';
    sourceShape = raw ? 'mixed' : 'json';
  }

  return {
    rtpba: extractRtpba(raw, json),
    schema_recommendations: extractSchemaRecommendations(raw, json),
    variance_score: extractVarianceScore(raw, json),
    variance_label: extractVarianceLabel(raw, json),
    structured_scores: extractStructuredScores(raw, json),
    blueprint_phases: extractBlueprintPhases(raw, json),
    cluster_synthesis: extractClusterSynthesis(raw, json),
    parser_version: PARSER_VERSION,
    parsed_at: new Date().toISOString(),
    source_shape: sourceShape
  };
}

// ────────────────────────────────────────────────────────────────────
// RTPBA extraction
// ────────────────────────────────────────────────────────────────────
function extractRtpba(raw, json) {
  // Structured JSON paths (legacy agent shape)
  if (json) {
    if (json.opportunities) {
      var opps = json.opportunities;
      if (typeof opps === 'object') {
        if (opps.ready_to_publish) return opps.ready_to_publish;
        if (opps.ready_to_publish_best_answer) return opps.ready_to_publish_best_answer;
        if (opps.rtpba) return opps.rtpba;
        if (opps.best_answer) return opps.best_answer;
      }
    }
    if (json.rtpba && typeof json.rtpba === 'string') return json.rtpba;
    if (json.ready_to_publish_best_answer && typeof json.ready_to_publish_best_answer === 'string') {
      return json.ready_to_publish_best_answer;
    }
  }

  if (!raw) return null;

  // Markdown shape (Anna's example): the RTPBA lives under
  //   ## Section 3 - Ready-to-Publish Best Answer
  // and ends at the next major section heading
  //   ## Section 4 - Structured Exports (or similar)
  //
  // Section 3 typically opens with an italic note then a horizontal rule then
  // the page title as H1. We capture from the first H1/H2 inside Section 3
  // through to the next ## Section heading.

  var startMarkers = [
    /## Section 3[^\n]*Ready-to-Publish Best Answer[^\n]*/i,
    /## Section 3[^\n]*Best Answer[^\n]*/i,
    /Ready-to-Publish Best Answer/i,
    /Ready to Publish Best Answer/i,
    /READY-TO-PUBLISH/i,
    /Best Answer Content/i,
    /Recommended Page Content/i
  ];

  var startIdx = -1;
  for (var i = 0; i < startMarkers.length; i++) {
    var m = raw.match(startMarkers[i]);
    if (m && typeof m.index === 'number') {
      // Skip past the marker line
      var nl = raw.indexOf('\n', m.index);
      startIdx = nl === -1 ? m.index + m[0].length : nl + 1;
      break;
    }
  }

  if (startIdx === -1) return null;

  // End: next major section. Section 3 body typically contains its own H2
  // sub-headings (`## What [Service] Looks Like`, `## Why [Audience]`, etc.)
  // and `---` horizontal rules between the regulated-niche notice and the
  // page H1. Earlier endMarker variants treated either pattern as a section
  // boundary and truncated RTPBA at ~1.4KB inside the first sub-section.
  //
  // Only treat NUMBERED Surge sections (Section 4 through Section 12) and a
  // small set of unmistakable post-Section-3 markers as boundaries. Internal
  // `---` separators and content sub-headings stay inside RTPBA.
  var endMarkers = [
    /\n## Section\s+(?:[4-9]|1[0-2])\b[^\n]*/i,
    /\n## STRUCTURED_SCORES\b/i,
    /\n## YOUR VARIANCE SCORE\b/i,
    /\n## Implementation Blueprint\b/i,
    /\n## PHASE\s+\d/i,
    /\n## SURGE ACTION PLAN\b/i,         // agent's tab-walk fence
    /\n## Cluster Synthesis\b/i,
    /\n## Interlink Recommendations\b/i,
    /\n```json\s*\n\s*\{[\s\S]{0,40}"metrics"/i,  // first STRUCTURED_SCORES JSON block, in case heading is missing
    /\nsurge_v3_output\b/i
  ];

  var endIdx = raw.length;
  for (var j = 0; j < endMarkers.length; j++) {
    // Anchor search 200 chars past startIdx so a marker on the SAME LINE as
    // the Section 3 heading (very rare but possible after stripping) doesn't
    // trip up the loop.
    var em = endMarkers[j].exec(raw.substring(startIdx + 200));
    if (em) {
      var absoluteEnd = startIdx + 200 + em.index;
      if (absoluteEnd < endIdx) endIdx = absoluteEnd;
    }
  }

  var content = raw.substring(startIdx, endIdx).trim();
  // Strip leading italic note / blockquote regulatory notice / leading HRs
  // that are decoration before the actual page markdown begins.
  content = content.replace(/^\s*\*[^\n]*\*\s*\n+/, '');     // leading italic line
  content = content.replace(/^>\s*[^\n]*(?:\n>[^\n]*)*\n+/, '');  // leading blockquote (Regulated-Niche Notice)
  content = content.replace(/^---+\s*\n+/, '');               // leading hr

  return content.length > 200 ? content : null;
}

// ────────────────────────────────────────────────────────────────────
// Schema recommendations extraction
// ────────────────────────────────────────────────────────────────────
function extractSchemaRecommendations(raw, json) {
  // Structured JSON paths
  if (json) {
    if (json.action_plan && typeof json.action_plan === 'object') {
      var ap = json.action_plan;
      if (ap.schema) return normalizeSchemaRecs(ap.schema);
      if (ap.schema_recommendations) return normalizeSchemaRecs(ap.schema_recommendations);
      if (ap.structured_data) return normalizeSchemaRecs(ap.structured_data);
    }
    if (json.intelligence && typeof json.intelligence === 'object') {
      if (json.intelligence.schema) return normalizeSchemaRecs(json.intelligence.schema);
    }
    if (json.schema_recommendations) return normalizeSchemaRecs(json.schema_recommendations);
  }

  if (!raw) return { blocks: [], notes: null };

  // Markdown shape: scan for JSON-LD code blocks (```json ... ```) inside
  // the Implementation Blueprint Phase 6 section. Capture each block as a
  // distinct schema recommendation, paired with the H3 heading above it
  // for context (e.g. "6.1 - Create and Deploy brand.jsonld").

  var blocks = [];
  var schemaSectionStart = raw.search(/## PHASE 6[^\n]*Schema/i);
  if (schemaSectionStart === -1) {
    schemaSectionStart = raw.search(/Schema.*Entity Identity/i);
  }
  if (schemaSectionStart === -1) schemaSectionStart = 0; // scan whole doc

  // Find next phase boundary
  var phaseEnd = raw.search(/## PHASE [0-9][^6]/i);
  if (phaseEnd === -1 || phaseEnd < schemaSectionStart) phaseEnd = raw.length;
  var schemaSection = raw.substring(schemaSectionStart, phaseEnd);

  // Extract every ```json ... ``` code block in this section
  // For each, also capture the most recent ### heading above it (within ~800 chars)
  var codeBlockRe = /```json\s*\n([\s\S]*?)```/g;
  var match;
  var idx = 0;
  while ((match = codeBlockRe.exec(schemaSection)) !== null && idx < 20) {
    var jsonText = (match[1] || '').trim();
    if (!jsonText) continue;
    // Look back up to 800 chars for the nearest ### heading
    var lookback = schemaSection.substring(Math.max(0, match.index - 800), match.index);
    var headingMatches = lookback.match(/###\s*([^\n]+)/g);
    var heading = headingMatches ? headingMatches[headingMatches.length - 1].replace(/^###\s*/, '').trim() : '';
    var entry = { heading: heading, raw_jsonld: jsonText, parsed: null, parse_error: null };
    try {
      entry.parsed = JSON.parse(jsonText);
    } catch (e) {
      entry.parse_error = e.message;
    }
    blocks.push(entry);
    idx++;
  }

  // Also extract any standalone ```json ... ``` blocks elsewhere in the doc
  // that look like JSON-LD (have @context or @type)
  if (blocks.length === 0) {
    var anyJsonRe = /```json\s*\n([\s\S]*?)```/g;
    var m2;
    var i2 = 0;
    while ((m2 = anyJsonRe.exec(raw)) !== null && i2 < 20) {
      var jt = (m2[1] || '').trim();
      if (!jt) continue;
      // Only keep if it has @context or @type (JSON-LD signature)
      if (jt.indexOf('@context') === -1 && jt.indexOf('@type') === -1) continue;
      var e2 = { heading: 'Detected JSON-LD block', raw_jsonld: jt, parsed: null, parse_error: null };
      try { e2.parsed = JSON.parse(jt); } catch (e) { e2.parse_error = e.message; }
      blocks.push(e2);
      i2++;
    }
  }

  return { blocks: blocks, notes: blocks.length === 0 ? 'No schema blocks found in source' : null };
}

function normalizeSchemaRecs(input) {
  if (!input) return { blocks: [], notes: null };
  if (Array.isArray(input)) {
    return { blocks: input.map(function(x) {
      if (typeof x === 'string') return { heading: '', raw_jsonld: x, parsed: null };
      return { heading: x.heading || x.label || '', raw_jsonld: x.raw_jsonld || x.jsonld || '', parsed: x.parsed || null };
    }), notes: null };
  }
  if (typeof input === 'object') {
    return { blocks: [{ heading: 'Schema', raw_jsonld: JSON.stringify(input), parsed: input }], notes: null };
  }
  if (typeof input === 'string') {
    return { blocks: [{ heading: 'Schema', raw_jsonld: input, parsed: null }], notes: null };
  }
  return { blocks: [], notes: null };
}

// ────────────────────────────────────────────────────────────────────
// Variance score extraction
// ────────────────────────────────────────────────────────────────────
function extractVarianceScore(raw, json) {
  if (json && typeof json.variance_score === 'number') return json.variance_score;
  if (json && json.surge_v3_output && typeof json.surge_v3_output.variance_score === 'number') {
    return json.surge_v3_output.variance_score;
  }

  if (!raw) return null;

  // "**YOUR VARIANCE SCORE: 37 / 100" pattern
  var m = raw.match(/YOUR VARIANCE SCORE:\s*\*?\*?\s*(\d{1,3})\s*\/\s*100/i);
  if (m) return parseInt(m[1], 10);
  // Alternate: "Baseline Score: 37/100"
  m = raw.match(/Baseline Score:\s*(\d{1,3})\s*\/\s*100/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

function extractVarianceLabel(raw, json) {
  if (json && typeof json.variance_label === 'string') return json.variance_label;

  if (!raw) return null;

  // "37 / 100 — Moderate Variance"
  var m = raw.match(/YOUR VARIANCE SCORE:\s*\*?\*?\s*\d{1,3}\s*\/\s*100\s*[—–-]\s*([A-Za-z ]+?)(?:\s*$|\n|\*)/im);
  if (m) return m[1].trim();
  m = raw.match(/Baseline Score:\s*\d{1,3}\/\s*100\s*[—–-]\s*([A-Za-z ]+?)(?:\s*$|\n|\*)/im);
  if (m) return m[1].trim();
  return null;
}

// ────────────────────────────────────────────────────────────────────
// STRUCTURED_SCORES extraction (metrics + brand_datasets)
// ────────────────────────────────────────────────────────────────────
function extractStructuredScores(raw, json) {
  if (json && json.metrics && Array.isArray(json.metrics)) {
    return { metrics: json.metrics, brand_datasets: json.brand_datasets || [] };
  }
  if (json && json.structured_scores) return json.structured_scores;

  if (!raw) return null;

  // Look for "## STRUCTURED_SCORES\n\n```json\n{...}\n```"
  var idx = raw.search(/##\s*STRUCTURED_SCORES/i);
  if (idx === -1) return null;
  var section = raw.substring(idx);
  var blockMatch = section.match(/```json\s*\n([\s\S]*?)```/);
  if (!blockMatch) return null;
  try {
    return JSON.parse(blockMatch[1]);
  } catch (e) {
    return { _raw: blockMatch[1], _parse_error: e.message };
  }
}

// ────────────────────────────────────────────────────────────────────
// Blueprint phases extraction (summary only — we don't explode to tasks)
// ────────────────────────────────────────────────────────────────────
function extractBlueprintPhases(raw, json) {
  if (json && json.blueprint_phases) return json.blueprint_phases;

  if (!raw) return [];

  // Find each "## PHASE N" heading and its first paragraph (priority + summary)
  var phases = [];
  var phaseRe = /## PHASE (\d+)[^\n]*-\s*([^\n]+)\n\*\*Priority:\s*([^*\n]+)\*\*/g;
  var m;
  while ((m = phaseRe.exec(raw)) !== null) {
    phases.push({
      phase_number: parseInt(m[1], 10),
      title: m[2].trim(),
      priority: m[3].trim()
    });
  }
  return phases;
}

// ────────────────────────────────────────────────────────────────────
// Cluster synthesis extraction (cross-page interlink recommendations)
// ────────────────────────────────────────────────────────────────────
function extractClusterSynthesis(raw, json) {
  if (json && json.cluster_synthesis) return json.cluster_synthesis;

  if (!raw) return null;

  // Cluster synthesis lives in the multi-page batch synthesis output, not in
  // single-page Surge output. Look for "Cluster Synthesis" or
  // "Interlink Recommendations" sections.
  var markers = [
    /## Cluster Synthesis[^\n]*/i,
    /## Interlink Recommendations[^\n]*/i,
    /## Cross-Page Recommendations[^\n]*/i
  ];
  for (var i = 0; i < markers.length; i++) {
    var m = raw.match(markers[i]);
    if (m && typeof m.index === 'number') {
      var startIdx = raw.indexOf('\n', m.index);
      if (startIdx === -1) startIdx = m.index + m[0].length;
      // End at next ## section
      var endRe = /\n## /g;
      endRe.lastIndex = startIdx + 1;
      var endMatch = endRe.exec(raw);
      var endIdx = endMatch ? endMatch.index : raw.length;
      var content = raw.substring(startIdx, endIdx).trim();
      if (content.length > 100) return content;
    }
  }
  return null;
}

module.exports = {
  parse: parse,
  PARSER_VERSION: PARSER_VERSION,
  // Internals exposed for testing
  _extractRtpba: extractRtpba,
  _extractSchemaRecommendations: extractSchemaRecommendations,
  _extractVarianceScore: extractVarianceScore,
  _extractVarianceLabel: extractVarianceLabel,
  _extractStructuredScores: extractStructuredScores,
  _extractBlueprintPhases: extractBlueprintPhases,
  _extractClusterSynthesis: extractClusterSynthesis
};
