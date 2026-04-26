// design-bans.js
//
// Anti-patterns and required practices injected into Pagemaster generation
// prompts. Sourced from the impeccable skill (.claude/skills/impeccable/).
// Single source of truth for prompt-time design guidance, kept here so any
// route generating HTML can pull from one place.
//
// See .claude/skills/impeccable/SKILL.md for the full design philosophy.
// See docs/impeccable-integration.md for the integration plan.

// ============================================================
// MOONRAKER_DESIGN_BANS
// Drop-in block for system prompts that produce HTML/CSS.
// ============================================================
var MOONRAKER_DESIGN_BANS = [
  '=== DESIGN ANTI-PATTERNS (NON-NEGOTIABLE) ===',
  '',
  'These rules apply to every page you generate. They are the difference between a',
  'site that looks designed and one that looks like generic AI output.',
  '',
  'ABSOLUTE BANS (never write these patterns regardless of context):',
  '',
  '1. Side-stripe colored borders on cards, list items, callouts, or alerts.',
  '   FORBIDDEN: border-left or border-right with width > 1px.',
  '   FORBIDDEN: any color (hex, rgb, oklch, var()).',
  '   This is the most overused "design touch" in admin/dashboard/medical UIs.',
  '   It never looks intentional. Use full borders, background tints, leading',
  '   icons, or no visual indicator instead.',
  '',
  '2. Gradient text via background-clip: text.',
  '   FORBIDDEN: background-clip: text or -webkit-background-clip: text combined',
  '   with any gradient (linear-gradient, radial-gradient, conic-gradient).',
  '   Use a single solid color for text. For emphasis use weight or size.',
  '',
  'STRONG BANS (do not use unless the brief explicitly requires it):',
  '',
  '- Pure #000 or #fff. Always tint slightly toward the brand hue.',
  '- Gray text on colored backgrounds. Use a darker shade of the background instead.',
  '- Glassmorphism, decorative blur, glass cards.',
  '- Decorative sparklines (tiny charts that convey nothing).',
  '- Generic rounded rectangle + drop shadow on every card.',
  '- Cards nested inside cards. Flatten with spacing and typography instead.',
  '- Identical card grids (same size, icon + heading + text, repeated).',
  '- Hero metric template (big number / small label / supporting stats / gradient).',
  '- Cyan-on-dark, purple-to-blue gradients, neon-on-dark — these are AI defaults.',
  '- Bounce or elastic easing curves. Real objects decelerate smoothly.',
  '',
  'REQUIRED PRACTICES:',
  '',
  '- Use OKLCH for color where possible. When given hex inputs from the design',
  '  spec, you may convert to OKLCH for derivative shades. Reduce chroma as',
  '  lightness approaches 0% or 100% — high chroma at extremes looks garish.',
  '- Tint neutrals 0.005 to 0.015 chroma toward the client primary brand hue.',
  '  Pure gray feels lifeless next to a colored brand.',
  '- 4pt spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 96. No off-scale values.',
  '- Use gap for sibling spacing, not margins.',
  '- Cap body line length at 65-75ch. Wider is fatiguing to read.',
  '- If light text on dark background, add 0.05 to 0.1 to your normal',
  '  line-height — light type reads as lighter weight.',
  '- :focus-visible for keyboard focus rings, never bare outline: none.',
  '- Animate transform and opacity only. For accordion/expand effects use',
  '  grid-template-rows transitioning 0fr to 1fr.',
  '- Motion durations: 100-150ms for instant feedback, 200-300ms for state',
  '  changes, 300-500ms for layout, 500-800ms for entrance reveals. Exit is',
  '  ~75% of enter duration.',
  '- prefers-reduced-motion is not optional. Provide a fade alternative.',
  '',
  'BUTTON / UI COPY:',
  '',
  '- Never use "OK", "Submit", "Yes", or "Click here" as button labels.',
  '- Use verb + object: "Book consultation", "Send message", "Read more about',
  '  anxiety treatment".',
  '- For destructive actions, name what is being destroyed.',
  '',
  'THE AI SLOP TEST:',
  '',
  'Before finalizing the page, ask: if someone said "AI made this," would the',
  'viewer believe it instantly? If yes, the design is generic. The patterns',
  'above are the fingerprints. Rewriting to avoid them is the work.'
].join('\n');

module.exports = {
  MOONRAKER_DESIGN_BANS: MOONRAKER_DESIGN_BANS
};
