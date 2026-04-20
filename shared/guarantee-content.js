// /shared/guarantee-content.js
// Shared Signed Performance Guarantee document builder.
// Single source of truth for the frozen-legal-text portion of the PG.
//
// When a client signs, the rendered HTML is snapshotted into
// signed_performance_guarantees.guarantee_terms_html so the prose and numbers
// they agreed to are preserved exactly as they appeared on-screen — even if
// this module is edited later.
//
// Usage:
//   <script src="/shared/guarantee-content.js"></script>
//   renderGuarantee(pgRow, contact)              — client-facing signing page
//   buildGuaranteeHtml(pgRow, contact)           — pure HTML string, for server-side snapshot
//
// The prose mirrors the "Performance Guarantee" section of the CSA
// (shared/csa-content.js). Any edits here must be mirrored there so the CSA's
// reference to "the Signed Performance Guarantee" stays accurate.
//
// Version: 2026-04-20

(function() {

  function _fmtCents(c) {
    if (c == null || isNaN(c)) return '$—';
    var d = c / 100;
    return '$' + d.toLocaleString('en-US', Number.isInteger(d) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _fmtRate(r) {
    if (r == null || isNaN(r)) return '—';
    return Math.round(Number(r) * 100) + '%';
  }

  function _fmtDate(d) {
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  function _esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // Build the document HTML. Pure function — no DOM side effects.
  //
  // effectiveStartDate/effectiveEndDate come from the server when rendering a
  // previously-signed document (so the dates stay stable), or default to today
  // + 12 months when previewing before signing.
  window.buildGuaranteeHtml = function(pgRow, contactParam, opts) {
    var pg = pgRow || {};
    var contact = contactParam || {};
    opts = opts || {};

    var firstName = contact.first_name || '';
    var lastName  = contact.last_name || '';
    var practiceName = contact.practice_name || ((firstName + ' ' + lastName).trim()) || '—';

    var startDate = opts.effectiveStartDate ? new Date(opts.effectiveStartDate) : new Date();
    var endDate;
    if (opts.effectiveEndDate) {
      endDate = new Date(opts.effectiveEndDate);
    } else {
      endDate = new Date(startDate.getTime());
      endDate.setFullYear(endDate.getFullYear() + 1);
    }

    var ltv           = _fmtCents(pg.avg_client_ltv_cents);
    var conv          = _fmtRate(pg.conversion_rate);
    var att           = _fmtRate(pg.attendance_rate);
    var valuePerCall  = _fmtCents(pg.value_per_call_cents);
    var investment    = _fmtCents(pg.investment_cents);
    var currentCalls  = (pg.current_monthly_organic_calls != null) ? pg.current_monthly_organic_calls : 0;
    var guaranteeCalls = (pg.guarantee_calls != null) ? pg.guarantee_calls : '—';
    var totalBenchmark = (pg.total_benchmark != null) ? pg.total_benchmark : '—';

    var html = ''
      + '<div class="pg-doc">'
      + '<div class="pg-meta">'
      +   '<div><span class="pg-meta-label">Client</span><span class="pg-meta-value">' + _esc(practiceName) + '</span></div>'
      +   '<div><span class="pg-meta-label">Effective</span><span class="pg-meta-value">' + _fmtDate(startDate) + ' &ndash; ' + _fmtDate(endDate) + '</span></div>'
      + '</div>'

      + '<h2>Signed Performance Guarantee</h2>'

      + '<p>This Signed Performance Guarantee (the &ldquo;<strong>Guarantee</strong>&rdquo;) is issued under, and governed by, the Client Service Agreement between Moonraker.AI, LLC (&ldquo;<strong>Moonraker</strong>&rdquo;) and ' + _esc(practiceName) + ' (the &ldquo;<strong>Client</strong>&rdquo;). The Guarantee captures the specific benchmark the parties agreed to during the intro call and is the controlling instrument for the guarantee terms described in the CSA.</p>'

      + '<h3>Your Personalized Benchmark</h3>'
      + '<p>The benchmark below is calculated from the Client&rsquo;s practice metrics as reviewed and confirmed with the Client on the intro call.</p>'
      + '<table class="pg-numbers">'
      +   '<tbody>'
      +     '<tr><td>Average Client Lifetime Value</td><td>' + ltv + '</td></tr>'
      +     '<tr><td>Consultation-to-Client Conversion Rate</td><td>' + conv + '</td></tr>'
      +     '<tr><td>Call Attendance Rate</td><td>' + att + '</td></tr>'
      +     '<tr><td>Resulting Value Per Booked Call</td><td><strong>' + valuePerCall + '</strong></td></tr>'
      +     '<tr><td>Current Monthly Organic Calls</td><td>' + currentCalls + '</td></tr>'
      +     '<tr><td>Annual Campaign Investment</td><td>' + investment + '</td></tr>'
      +     '<tr class="pg-row-emphasis"><td>Guarantee Calls Over 12 Months</td><td><strong>' + _esc(String(guaranteeCalls)) + '</strong></td></tr>'
      +     '<tr class="pg-row-emphasis"><td>Total 12-Month Benchmark (Current Run Rate + Guarantee)</td><td><strong>' + _esc(String(totalBenchmark)) + ' organic calls</strong></td></tr>'
      +   '</tbody>'
      + '</table>'

      + '<h3>The Guarantee</h3>'
      + '<p>If Moonraker does not achieve the Total 12-Month Benchmark above within 12 months from the date of this Guarantee, Moonraker will continue delivering the Services set out in the CSA at no additional cost to the Client until the benchmark is achieved.</p>'

      + '<h3>Scope</h3>'
      + '<p>The Guarantee counts only consultations originating from organic channels: Google Search, Google Maps, and AI Search. Consultations from paid advertising, referrals, or other sources do not count toward the benchmark. The Client agrees to grant Moonraker access to relevant systems (website analytics and booking platforms) so performance can be tracked accurately.</p>'

      + '<h3>Effective Dates</h3>'
      + '<p>This Guarantee is effective from <strong>' + _fmtDate(startDate) + '</strong> through <strong>' + _fmtDate(endDate) + '</strong>. If the Client upgrades from a non-commitment plan to an annual plan mid-engagement, a new Signed Performance Guarantee is issued with a fresh 12-month window starting from the new signing date.</p>'

      + '<h3>Relationship to the Client Service Agreement</h3>'
      + '<p>The CSA remains the parent agreement and governs all matters not specifically addressed in this Guarantee (including payment terms, scope of work, cancellation, and dispute resolution). In the event of a conflict between this Guarantee and the CSA, the terms of this Guarantee control only with respect to the performance benchmark described above; all other matters are governed by the CSA.</p>'

      + '</div>';

    return html;
  };

  // Full render: inserts HTML into #guaranteeDocument and pre-fills the
  // signature fields. Validation wiring is handled in the template so sign-
  // button state can react to the canvas.
  window.renderGuarantee = function(pgRow, contactParam, opts) {
    var contact = contactParam || {};
    var html = window.buildGuaranteeHtml(pgRow, contact, opts);

    var docEl = document.getElementById('guaranteeDocument');
    if (docEl) docEl.innerHTML = html;

    // Prefill signature fields where present
    var clientName = ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
    var sigName = document.getElementById('sigName');
    var sigEmail = document.getElementById('sigEmail');
    var sigDate = document.getElementById('sigDate');
    if (sigName && !sigName.value) sigName.value = clientName;
    if (sigEmail && !sigEmail.value) sigEmail.value = contact.email || '';
    if (sigDate) sigDate.value = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // Let the template re-run its own validator if it installed one
    if (typeof window.validateSignFields === 'function') window.validateSignFields();
  };

})();
