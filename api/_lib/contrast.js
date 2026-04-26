// /api/_lib/contrast.js
// WCAG AA contrast clamping for client design tokens.
//
// Used in two places (belt + suspenders):
//   1. /api/analyze-design-spec — clamps Claude's distilled palette before
//      writing to design_specs.color_palette. Data at rest is AA-compliant.
//   2. Template renderer — clamps again before binding CSS variables, so
//      legacy rows / manually-edited rows can't break v3 audits.
//
// What we clamp:
//   - body_text against background and surface (need 4.5:1)
//   - heading_text against background and surface (need 4.5:1; large text 3:1
//     would be permissive but body copy uses headings too, so we hold the
//     stricter line)
//   - muted_text against background and surface (need 4.5:1 — the 9ea7a7
//     case Mark hit; "muted" UI tone has historically been the worst
//     offender)
//   - cta_text against cta_background (need 4.5:1)
//
// What we DON'T clamp:
//   - primary, secondary, accent — these are decorative/brand colors. Used
//     for borders, icons, accents. Forcing AA contrast on them would alter
//     brand identity. The renderer is responsible for never placing body
//     text directly on these without a backing surface.
//
// Strategy:
//   - If the foreground passes against ALL referenced backgrounds, no change.
//   - Otherwise, walk the foreground toward black (for light backgrounds) or
//     white (for dark backgrounds) in HSL lightness steps until it passes,
//     preserving hue and saturation as much as possible. Brand intent stays
//     readable: #9ea7a7 (muted teal-grey) becomes #6b7878, not just #555.
//
// Pure functions — no IO, no Supabase, no fetch. Safe to call from
// renderer (cold-path) or analyze (hot-path).

// ── color parsing ───────────────────────────────────────────────────────

function parseColor(input) {
  if (!input || typeof input !== 'string') return null;
  var s = input.trim().toLowerCase();

  // #rgb / #rrggbb
  if (s.charAt(0) === '#') {
    var hex = s.substring(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex.charAt(0) + hex.charAt(0), 16),
        g: parseInt(hex.charAt(1) + hex.charAt(1), 16),
        b: parseInt(hex.charAt(2) + hex.charAt(2), 16)
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.substring(0, 2), 16),
        g: parseInt(hex.substring(2, 4), 16),
        b: parseInt(hex.substring(4, 6), 16)
      };
    }
    return null;
  }

  // rgb(...) / rgba(...)
  var m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
  }

  return null;
}

function toHex(rgb) {
  function p(n) {
    var v = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return v.length === 1 ? '0' + v : v;
  }
  return '#' + p(rgb.r) + p(rgb.g) + p(rgb.b);
}

// ── relative luminance + contrast (WCAG 2.x) ────────────────────────────

function srgbChannel(c) {
  var v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb) {
  return 0.2126 * srgbChannel(rgb.r) + 0.7152 * srgbChannel(rgb.g) + 0.0722 * srgbChannel(rgb.b);
}

function contrastRatio(rgb1, rgb2) {
  var l1 = relativeLuminance(rgb1);
  var l2 = relativeLuminance(rgb2);
  var lighter = Math.max(l1, l2);
  var darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── HSL conversion (for hue-preserving lightness adjustment) ────────────

function rgbToHsl(rgb) {
  var r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h, s, l = (max + min) / 2;
  if (max === min) {
    h = 0; s = 0;
  } else {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: h, s: s, l: l };
}

function hslToRgb(hsl) {
  var h = hsl.h, s = hsl.s, l = hsl.l;
  var r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}

// ── core clamp ──────────────────────────────────────────────────────────

// Walks the foreground's HSL lightness toward whichever pole gives more
// contrast against ALL backgrounds simultaneously, until ratio >= target
// against every background. Returns the adjusted hex, or the original if
// already passing.
function clampToContrast(fg, backgrounds, targetRatio) {
  var fgRgb = parseColor(fg);
  if (!fgRgb) return fg;

  var bgRgbList = backgrounds
    .map(parseColor)
    .filter(function(c) { return c !== null; });
  if (bgRgbList.length === 0) return fg;

  // Already passes everywhere?
  var allPass = bgRgbList.every(function(bg) {
    return contrastRatio(fgRgb, bg) >= targetRatio;
  });
  if (allPass) return fg;

  // Decide which pole to walk toward. Use average background luminance:
  // light backgrounds → walk fg toward black; dark backgrounds → toward white.
  var avgBgLum = bgRgbList.reduce(function(acc, bg) {
    return acc + relativeLuminance(bg);
  }, 0) / bgRgbList.length;
  var walkToward = avgBgLum > 0.5 ? 0 : 1; // target HSL lightness

  var hsl = rgbToHsl(fgRgb);
  var startL = hsl.l;
  var step = walkToward === 0 ? -0.02 : 0.02;

  // Up to 50 steps of 2% lightness = 100% of the L axis. Bounded loop.
  for (var i = 0; i < 50; i++) {
    var nextL = startL + step * (i + 1);
    if (nextL < 0) nextL = 0;
    if (nextL > 1) nextL = 1;
    var candidate = hslToRgb({ h: hsl.h, s: hsl.s, l: nextL });
    var passes = bgRgbList.every(function(bg) {
      return contrastRatio(candidate, bg) >= targetRatio;
    });
    if (passes) return toHex(candidate);
    if ((step < 0 && nextL <= 0) || (step > 0 && nextL >= 1)) break;
  }

  // Couldn't reach target along the lightness axis (e.g. fully desaturated
  // already, or backgrounds are mid-grey). Fall back to pure black/white.
  return walkToward === 0 ? '#000000' : '#FFFFFF';
}

// ── palette-level convenience ───────────────────────────────────────────

// Backwards-compatible: takes a color_palette object, returns a NEW object
// with clamped text colors. Original is not mutated. Adds a _contrast_clamp
// metadata key listing which fields were adjusted, so observability has a
// trail. Empty {} when nothing changed.
function clampPalette(palette) {
  if (!palette || typeof palette !== 'object') return palette;

  // Strip prior clamp metadata so re-clamping a previously-clamped palette
  // is fully idempotent (no key churn when nothing actually changed).
  var out = Object.assign({}, palette);
  delete out._contrast_clamp;

  var changes = {};

  // Anchor backgrounds: prefer explicit background + surface; if surface
  // is missing, just use background. White and the background color are
  // both surfaces in v3 templates (cards, alternating sections).
  var bgList = [];
  if (palette.background) bgList.push(palette.background);
  if (palette.surface && palette.surface !== palette.background) bgList.push(palette.surface);
  // v3 template alternates sections — include #ffffff as a guaranteed
  // surface so muted-text on white cards is also covered.
  if (bgList.indexOf('#ffffff') === -1 && bgList.indexOf('#FFFFFF') === -1) {
    bgList.push('#ffffff');
  }

  function maybeClamp(key, target) {
    if (!palette[key]) return;
    var clamped = clampToContrast(palette[key], bgList, target);
    if (clamped.toLowerCase() !== String(palette[key]).toLowerCase()) {
      changes[key] = { from: palette[key], to: clamped };
      out[key] = clamped;
    }
  }

  // 4.5:1 for body, 4.5:1 for heading (we hold the stricter line; large
  // headings could use 3:1 but body copy uses heading_text too at smaller
  // sizes in v3 cards), 4.5:1 for muted (this is the chronic offender).
  maybeClamp('body_text', 4.5);
  maybeClamp('heading_text', 4.5);
  maybeClamp('muted_text', 4.5);

  // CTA text against CTA background — separate axis.
  if (palette.cta_text && palette.cta_background) {
    var ctaClamped = clampToContrast(palette.cta_text, [palette.cta_background], 4.5);
    if (ctaClamped.toLowerCase() !== String(palette.cta_text).toLowerCase()) {
      changes.cta_text = { from: palette.cta_text, to: ctaClamped };
      out.cta_text = ctaClamped;
    }
  }

  if (Object.keys(changes).length > 0) {
    out._contrast_clamp = changes;
  }

  return out;
}

module.exports = {
  parseColor: parseColor,
  toHex: toHex,
  contrastRatio: contrastRatio,
  clampToContrast: clampToContrast,
  clampPalette: clampPalette
};
