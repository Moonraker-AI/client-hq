// /shared/csa-content.js
// Shared CSA document builder for all onboarding pages.
// Single source of truth for the Client Service Agreement text.
// When a client signs, the rendered HTML is snapshotted into signed_agreements.document_html.
//
// Usage: <script src="/shared/csa-content.js"></script>
// Call:  renderCSA(contact)              — on onboarding, uses window._csaPricing
//        buildCSAHtml(contact, pricing)  — pass explicit pricing for standalone renders
//
//        where contact has: first_name, last_name, credentials,
//        practice_name, practice_address_line1, city, state_province, postal_code,
//        country, plan_type, email
//
//        and pricing (optional) is the shape returned by GET /api/pricing with
//        no product filter: { tiers: [{tier_key, amount_cents, ...}], config: {key: value} }
//
// Pricing resolution falls back to the built-in PRICE_DEFAULTS if pricing is
// not supplied or a tier is missing — so the /agreement reference page and
// any offline snapshot still render with sensible numbers even if the API is
// unreachable. Signed CSAs freeze the resolved HTML into
// signed_agreements.document_html, so the prices a client agreed to remain
// visible even after admins edit pricing_tiers.
//
// Version: 2026-04-20 (pricing pulled from pricing_tiers + pricing_config)

// Dollar amounts in cents. These mirror the values that were literally hardcoded
// in this file before 2026-04-20; if /api/pricing is unreachable, the CSA still
// renders with today's pricing. Keep in sync if pricing_tiers schema changes.
var PRICE_DEFAULTS = {
  annual_upfront_ach:        2000000,
  annual_quarterly_ach:       500000,
  annual_monthly_ach:         166700,
  quarterly_upfront_ach:      500000,
  quarterly_monthly_ach:      166700,
  monthly_ach:                200000,
  additional_service_page_ach:     30000,
  additional_service_page_cc:      31050,
  additional_press_release_ach:    30000,
  additional_press_release_cc:     31050,
  nap_update_ach:                  30000,
  nap_update_cc:                   31050,
  // Legacy aliases — kept so any older page with a stale reference still resolves
  additional_service_page:         30000,
  additional_press_release:        30000,
  content_edit_republish:          30000,
  nap_update:                      30000
};
var CONFIG_DEFAULTS = { cc_surcharge_pct: 3.5 };

function _fmtCents(c) {
  if (c == null || isNaN(c)) return '$—';
  var d = c / 100;
  return '$' + d.toLocaleString('en-US', Number.isInteger(d) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Build a pricing helper from a /api/pricing response (or nothing → defaults).
function resolvePricing(pricing) {
  var tierMap = {};
  var configMap = Object.assign({}, CONFIG_DEFAULTS);
  if (pricing && Array.isArray(pricing.tiers)) {
    pricing.tiers.forEach(function(t) {
      if (t && t.tier_key && typeof t.amount_cents === 'number') {
        tierMap[t.tier_key] = t.amount_cents;
      }
    });
  }
  if (pricing && pricing.config) {
    Object.keys(pricing.config).forEach(function(k) {
      var v = Number(pricing.config[k]);
      if (isFinite(v)) configMap[k] = v;
    });
  }
  function cents(key) {
    return (tierMap[key] != null) ? tierMap[key] : PRICE_DEFAULTS[key];
  }
  return {
    price: function(key) { return _fmtCents(cents(key)); },
    priceCents: cents,
    priceExpr: function(key, multiplier) { return _fmtCents(Math.round(cents(key) * multiplier)); },
    ccSurchargePct: configMap.cc_surcharge_pct
  };
}

// Optional helper: fetch current pricing into window._csaPricing so subsequent
// buildCSAHtml() / renderCSA() calls pick it up automatically. Returns a Promise
// that resolves to the pricing object (or null if the API is unreachable —
// which is fine, defaults cover it).
window.loadCSAPricing = function() {
  return fetch('/api/pricing')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (data && (data.tiers || data.config)) window._csaPricing = data;
      return data;
    })
    .catch(function() { return null; });
};

// Pure HTML builder. Can be called by any page that just needs to render
// the CSA text, including /agreement which has no signature fields.
window.buildCSAHtml = function(contactParam, pricingParam) {
    var contact = contactParam || window._onboardingContact || {};
    var P = resolvePricing(pricingParam || window._csaPricing);
    var clientName = (contact.first_name || '') + ' ' + (contact.last_name || '');
    if (contact.credentials) clientName += ', ' + contact.credentials;
    var practiceName = contact.practice_name || 'the Client';
    var addr = [contact.practice_address_line1, contact.city, contact.state_province, contact.postal_code, contact.country].filter(Boolean).join(', ');
    var planLabel = 'Per-location CORE Marketing Campaign';
    if (contact.plan_type === 'annual') planLabel = '12-Month CORE Marketing Campaign';
    else if (contact.plan_type === 'quarterly') planLabel = '3-Month CORE Marketing Campaign';
    else if (contact.plan_type === 'monthly') planLabel = 'Month-to-Month CORE Marketing Campaign';

    var html = '<div class="csa-header">' +
      '<h3>Moonraker Client Service Agreement</h3>' +
      '<p style="margin:0;font-size:.875rem;color:var(--color-muted)">This Client Service Agreement ("the Agreement") is entered into between:</p>' +
      '<p style="margin:.5rem 0 0;font-size:.875rem;"><strong>Moonraker.AI, LLC</strong>, a Massachusetts limited liability company, located at 119 Oliver St, Easthampton, MA 01027 ("Moonraker")</p>' +
      '<p style="margin:.25rem 0 0;font-size:.875rem;">and</p>' +
      '<p style="margin:.25rem 0 0;font-size:.875rem;"><strong><span class="dynamic-field">' + practiceName + '</span></strong>' + (addr ? ', ' + addr : '') + ' ("the Client")</p>' +
      '<p style="margin:.75rem 0 0;font-size:.8125rem;color:var(--color-muted);">Plan: <span class="dynamic-field">' + planLabel + '</span></p>' +
      '</div>';

    html += '<h4>Purpose of the Agreement</h4>' +
      '<p>The purpose of the Agreement is to set a clear, mutual understanding between Moonraker and the Client regarding the scope, objectives, and deliverables of the digital marketing services provided by Moonraker to the Client ("the Services"). It outlines the details of the Services, while also specifying the Client\'s responsibilities. The Agreement is essential to ensure that both parties are aligned on the goals, timelines, and measurable outcomes of the Services, thus minimizing misunderstandings and setting a clear path for collaboration and success.</p>';

    html += '<h4>Scope of Services and Limitations</h4>' +
      '<p>Moonraker is your dedicated marketing and SEO team, and our mission is simple: to help potential clients find your practice when they\'re searching for the support you provide. To ensure there is clarity on what\'s included in our partnership, it\'s important to note what Moonraker does and doesn\'t handle. The sections below outline exactly what services Moonraker provides, what falls outside our expertise, and how we\'ll work together when questions arise.</p>';

    html += '<h4>What Moonraker DOES Provide</h4>' +
      '<ul><li>Digital marketing strategy</li><li>Initial campaign setup and configuration</li><li>Technical website optimization</li><li>Search Engine Optimization (SEO) and Answer Engine Optimization (AEO)</li></ul>' +
      '<p>The complete scope of your specific project is outlined in the Statement of Work section of this Agreement.</p>';

    html += '<h4>What Moonraker Does NOT Provide</h4>' +
      '<p><strong>Website Infrastructure and Hosting:</strong> Website hosting services or server management, ongoing security monitoring, patches, or updates, SSL certificate management, website backups, DNS or domain management, ongoing website maintenance beyond SEO-related updates, or installation and management of website plugins that fall outside our immediate SEO work.</p>' +
      '<p><strong>Third-Party Platform Management:</strong> Ongoing management, technical support, or troubleshooting for third-party platforms, including: Electronic Health Records (EHR) systems, booking and scheduling platforms, CRM systems, email marketing platforms, payment processing systems, communication tools, practice management software, and any other third-party applications or services.</p>' +
      '<p><em>Important Clarification:</em> When we perform initial setup or configuration of platforms like your booking calendar and communication tools as part of your Statement of Work, this is a one-time implementation. Ongoing management, updates, troubleshooting, or monitoring of these platforms is not included unless explicitly stated in your monthly deliverables.</p>' +
      '<p><strong>HIPAA Compliance and Regulatory Consulting:</strong> Moonraker does not provide legal, compliance, or regulatory consulting services of any kind, including HIPAA compliance guidance or auditing, healthcare regulatory compliance advice, data privacy regulation guidance (GDPR, CCPA, etc.), professional licensing requirements, industry-specific compliance standards, or Business Associate Agreement (BAA) consulting beyond marketing services.</p>';

    html += '<h4>The Gray Area (When We\'ll Still Help)</h4>' +
      '<p><strong>We WILL:</strong> Answer questions about tools and integrations we installed (even months after setup), help troubleshoot tracking codes or analytics we implemented, guide you through basic fixes for marketing-related issues, point you toward the right resources or vendors for issues we can\'t handle, and provide reasonable support for minor issues related to our initial work.</p>' +
      '<p><strong>We WON\'T:</strong> Act as ongoing technical support for your EHR or booking platform, monitor your website for security vulnerabilities or breaches, provide general IT support for technology issues, take responsibility for third-party platform outages or functionality issues, guarantee the ongoing functionality of platforms we don\'t control, or install and manage website plugins that fall outside our immediate SEO work.</p>' +
      '<p>If you\'re ever unsure whether something falls within our scope, just ask. We\'ll give you a clear, honest answer and point you in the right direction if it\'s outside our expertise.</p>';

    html += '<h4>Your Responsibilities as the Client</h4>' +
      '<p><strong>Platform Selection and Management:</strong> Selecting appropriate third-party service providers and platforms, ensuring all third-party platforms meet your compliance and security requirements, managing user access, permissions, and security settings for all platforms, and reviewing platform terms of service and privacy policies.</p>' +
      '<p><strong>Compliance and Regulatory Matters:</strong> Ensuring your business operations, website, and third-party platforms comply with applicable laws and regulations (HIPAA, state regulations, etc.), consulting with legal or compliance professionals when guidance is needed, and implementing required privacy policies, terms of service, and consent mechanisms on your website.</p>' +
      '<p><strong>Data and Security Management:</strong> Monitoring for and responding to security incidents or data breaches, maintaining backups of all data and systems, coordinating with third-party platform vendors for support and issue resolution, and implementing appropriate security measures to protect client data.</p>' +
      '<p><strong>Website and Infrastructure:</strong> Maintaining website hosting, security updates, and backups, ensuring your website platform and plugins stay updated, and managing domain registration and DNS settings.</p>';

    html += '<h4>Limited Warranties for Integration Work</h4>' +
      '<p><strong>Our Responsibility:</strong> Correct technical implementation of the integration at the time of installation, following industry best practices for implementation, testing the integration to ensure it works at the time of setup, and providing documentation or basic guidance on how the integration functions.</p>' +
      '<p><strong>Our Limitations:</strong> We make no warranties regarding the security, compliance, or ongoing performance of third-party platforms. We are not responsible for changes made by third-party platform providers after our initial implementation, issues caused by platform updates, service outages, or policy changes, or compliance violations related to your selection or use of third-party platforms.</p>' +
      '<p><strong>Your Responsibility:</strong> Vetting and selecting platforms that meet your specific compliance requirements, understanding how platforms handle, store, and process data, monitoring integrations for ongoing functionality, and contacting platform vendors directly for platform-specific technical issues or support.</p>';

    html += '<h4>Liability and Indemnification</h4>' +
      '<p>You acknowledge and agree that Moonraker is not responsible or liable for: security breaches, data breaches, or compliance violations involving your website, third-party platforms, or systems (unless directly and solely caused by Moonraker\'s proven negligence in performing services within our stated scope); your failure to maintain compliance with applicable laws and regulations; issues arising from third-party platforms, services, or vendors that you selected or use; or modifications made to your website, integrations, or third-party platforms by you or other parties after Moonraker\'s initial implementation.</p>' +
      '<p>The Client agrees to indemnify and hold Moonraker harmless from any claims, damages, losses, or expenses (including attorney fees) arising from or related to: security breaches, data breaches, or compliance violations involving the Client\'s website, third-party platforms, or systems; the Client\'s failure to maintain compliance with applicable laws and regulations; issues arising from third-party platforms, services, or vendors selected or used by the Client; or any modifications made to the website or third-party integrations by the Client or other parties after Moonraker\'s initial implementation.</p>' +
      '<p>Moonraker maintains appropriate professional liability insurance and takes full responsibility for work performed within our defined scope of services.</p>';

    html += '<h4>Clarification Requests</h4>' +
      '<p>If the Client is uncertain whether a requested service falls within Moonraker\'s scope of work, the Client agrees to submit a written request for clarification prior to assuming such services are included. Moonraker will respond in writing within 2 business days to confirm whether the requested service is included or would constitute additional work requiring a separate agreement and fees.</p>';

    html += '<h4>Ownership</h4>' +
      '<p>The Client represents and warrants to Moonraker that the Client owns and/or has a legitimate legal license to use for business purposes, all photos, text, artwork, graphics, designs, trademarks, and other materials provided by the Client for Moonraker\'s use, including on the Website, and that the Client has obtained all waivers, authorizations, and other documentation that may be appropriate to evidence such Ownership. The Client shall indemnify and hold Moonraker harmless from all losses and claims, including attorney fees and legal expenses, that may result by reason of claims by third parties related to such materials.</p>';

    html += '<h4>Alteration</h4>' +
      '<p>Terms of this agreement are renegotiable after 90 days. After 12 months, Moonraker rates are subject to change for all services. In the event that the scope of work is required to change due to any of the agreed upon terms in this contract before or after the end of this agreement, Moonraker reserves the right to cancel or renegotiate this Agreement and the Client reserves the right to accept or reject the new terms provided. Any alteration that takes place prior will be agreed upon by both Moonraker and the Client, and new paperwork will be issued for handling in addition to the new rates applied after the alteration.</p>';

    html += '<h4>Intellectual Property</h4>' +
      '<p><strong>Client Ownership of Deliverables:</strong> Upon completion of the Services and receipt of full payment, the Client shall own all tangible work product and deliverables created specifically for the Client, including but not limited to: the Client\'s website, Google Business Profile, content created for the Client, and data/analytics reports provided to the Client. The Client may continue to use, modify, and maintain these deliverables without additional consent or compensation from Moonraker.</p>' +
      '<p><strong>Moonraker\'s Proprietary Methods:</strong> Moonraker retains all ownership and intellectual property rights to its proprietary processes, methodologies, tools, software, frameworks, and strategic approaches used in delivering the Services. These proprietary methods represent Moonraker\'s competitive advantage and trade secrets.</p>';

    html += '<h4>Mutual Confidentiality</h4>' +
      '<p>Moonraker will not directly share or divulge any type of proprietary or private information of the Client\'s in any form. Moonraker will protect such information and treat it as strictly confidential. This provision shall continue to be effective until the end of the Agreement. The Client shall not at any time or in any manner, either directly or indirectly, use for the personal benefit of the Client, or divulge, or otherwise communicate in any manner any information that is proprietary to Moonraker as it relates to Moonraker\'s proprietary strategy and structure of the Services. Both parties shall continue to hold each other in good faith after the termination of the Agreement.</p>';

    html += '<h4>Independent Contractor</h4>' +
      '<p>Moonraker is an independent contractor with respect to its relationship to the Client. Moonraker shall not be deemed, for any purpose, an employee of the Client.</p>';

    html += '<h4>Warranty</h4>' +
      '<p>Moonraker represents and warrants that it has the unencumbered right and power to enter into and perform the Agreement and that Moonraker is not aware of any claims or basis for claims of infringement of any patent, trademark, copyright, trade secret, or contractual or other proprietary rights of third parties in or to any materials included by Moonraker in the Services or trade names related to the Services.</p>';

    html += '<h4>Limitation of Liability</h4>' +
      '<p>Under no circumstances shall either party be liable to the other party or any third party for indirect incidental, consequential, special, or exemplary damages (even if that party has been advised of the possibility of such damages), arising from any provision of the Agreement. This includes, but is not limited to, loss of revenue or anticipated profit or lost business, costs of delay or failure of delivery, or liabilities to third parties arising from any source. Interruptions to the Services such as acts of God, war, fire, law, restrictions, and other causes are not at the fault of either the Client or Moonraker at any time.</p>';

    html += '<h4>Indemnity</h4>' +
      '<p>Each party agrees to defend, indemnify, and hold harmless the other party and its business partners from any and all third party claims, demands, liabilities, costs and expenses, including reasonable attorney fees, costs and expenses resulting from the indemnifying party\'s material breach of any duty, representation, or warranty under this agreement.</p>';

    html += '<h4>Legal Notice</h4>' +
      '<p>Neither Moonraker nor any of its employees or agents warrants that the functions contained in the Services will be uninterrupted or error-free. The entire risk as to the quality and performance is with the Client. In no event will Moonraker be liable to the Client or any third party for any claimed damages, including those resulting from service interruptions caused by Acts of God, the Hosting Service or any other circumstances beyond Moonraker\'s reasonable control; any lost profits, lost savings or other incidental, consequential, punitive, or special damages arising out of the operation of or inability to operate the Services; or failure of any service provider, telecommunications carrier, Internet backbone, Internet servers, or the Client\'s site visitor\'s computer or Internet software.</p>';

    html += '<h4>Account Access</h4>' +
      '<p><strong>Client Ownership:</strong> The Client retains primary ownership and control of all accounts, profiles, and digital assets. The Client agrees to grant Moonraker administrator-level access necessary to perform the Services as outlined in this Agreement.</p>' +
      '<p><strong>Access Requirements:</strong> The Client shall provide and maintain administrator-level access for Moonraker to all relevant accounts and platforms required to deliver the Services. This access must remain active and uninterrupted throughout the duration of the contract.</p>' +
      '<p><strong>Access Stability:</strong> Both parties agree not to modify login credentials, revoke access, or change account permissions without prior written notice to the other party. If a password change or access modification is required for security or operational reasons, the initiating party shall provide written notice at least 48 hours in advance when feasible.</p>' +
      '<p><strong>Third-Party Access:</strong> The Client agrees to notify Moonraker in writing before granting account access to any third parties, including other agencies, contractors, consultants, employees, or vendors who will have access to accounts where Moonraker is actively providing Services.</p>' +
      '<p><strong>Service Interference:</strong> If the Client or any third party granted access by the Client takes actions that interfere with Moonraker\'s ability to perform the Services (including but not limited to: modifying code, changing configurations, altering strategies, or revoking necessary permissions), the Client assumes full responsibility for any resulting issues. Moonraker shall not be held liable for outcomes resulting from such interference.</p>';

    html += '<h4>Communication</h4>' +
      '<p>Within the duration of the Agreement, Moonraker will make every effort to reply to inquiries within 24-72 hours except where the Client has been previously notified of a period of limited availability. Moonraker will respond in good faith but cannot guarantee any specific action within a given time frame. The Services will be provided in a timely and professional manner.</p>';

    html += '<h4>Ethics</h4>' +
      '<p>Moonraker will conduct services so long as the Client\'s requests remain ethical. Any requests to provide black hat or otherwise questionable tactics in relation to a service Moonraker delivers may result in the immediate cancellation of the Agreement. The Client acknowledges that Moonraker has educated them on any services that they are requesting which may be illegal or unethical.</p>';

    html += '<h4>Termination</h4>' +
      '<p>Moonraker may terminate the contract if the Client violates any ethical or legal standards. Unless otherwise terminated, the Agreement will terminate upon completion of the Services.</p>';

    html += '<h4>Termination on Default</h4>' +
      '<p>If the Client defaults by failing to substantially perform any provision, term, or condition of the Agreement (including failure to make monetary payment when due), Moonraker may terminate the Agreement by providing notice to the defaulting party. The notice shall describe the nature of the default. The Client shall have 15 days from the effective date of such notice to cure the default(s). Unless waived by the party providing the notice, the failure to cure the default(s) within such a time period shall result in the termination of the Agreement. Moonraker is owed in full for any type of Termination on Default, and the Client agrees to remedy Moonraker for all costs agreed upon in this agreement in full.</p>';

    html += '<h4>Governing Forum</h4>' +
      '<p>The Agreement shall be construed in accordance with the internal laws of Hampshire County, in the State of Massachusetts, without regard to conflict of laws rules. Venue shall be in a court of competent jurisdiction in the State of Massachusetts, and both parties expressly consent to jurisdiction in such courts. All and any disputes will be settled through mediation.</p>';

    html += '<h4>Complete Contract / Amendment</h4>' +
      '<p>The Agreement supersedes all prior agreements and understandings between the parties for performance of the Services, and constitutes the complete agreement and understanding between the parties. The parties may amend the Agreement in a written document signed by both parties. All prices specified in this contract will be honored for 12 months after both parties sign this contract. Continuation of the Services after that time will require a new agreement.</p>';

    html += '<h4>Payment Terms</h4>' +
      '<p>All payments shall be made digitally using Moonraker\'s digital payment processing of choice. If the Services are paid for digitally via credit card or eChecks, processing and service fees from the transaction will be passed on to the Client. If payment is not made in full, Moonraker retains full ownership of content not provided by the Client, and shall not be required to release any property until Moonraker is fully compensated for the Services. The Client is responsible for all third party fees and costs associated with the Services in addition to Moonraker\'s fees for the Services. Any technology paid for by Moonraker will be removed and/or cease to function at the end of the Agreement if the Client doesn\'t purchase said technology from Moonraker or a third party. All payments are final.</p>';

    html += '<h4>Service Fees</h4>' +
      '<p>All fees for the Services must be paid in full at the start of the scheduled payment term, known as the Effective Date. The Effective Date of the Services is the date when payment is processed. Fees are determined by the campaign scope and payment term chosen by the Client. The Client\'s chosen plan and payment term are recorded in Moonraker\'s client management system. If payment is not received by the Effective Date, Moonraker reserves the right to withhold any Services for which payment is due.</p>';

    html += '<h4>Pricing & Plans</h4>' +
      '<p>Moonraker offers six pricing options for the CORE Marketing Campaign, grouped by whether a 12-month commitment is included. Annual commitment plans unlock the Performance Guarantee described in the next section; non-commitment plans do not.</p>' +
      '<p><strong>Annual Commitment (12 months, Performance Guarantee included):</strong></p>' +
      '<ul>' +
      '<li><strong>Annual Paid Upfront:</strong> ' + P.price('annual_upfront_ach') + ' one-time. Also includes a custom website built on Moonraker\'s hosting infrastructure.</li>' +
      '<li><strong>Annual Paid Quarterly:</strong> ' + P.price('annual_quarterly_ach') + ' per quarter, four payments over 12 months.</li>' +
      '<li><strong>Annual Paid Monthly:</strong> ' + P.price('annual_monthly_ach') + ' per month for 12 months.</li>' +
      '</ul>' +
      '<p><strong>No Commitment (Performance Guarantee not included):</strong></p>' +
      '<ul>' +
      '<li><strong>Quarterly Upfront:</strong> ' + P.price('quarterly_upfront_ach') + ' one-time for three months of service.</li>' +
      '<li><strong>Quarterly Paid Monthly:</strong> ' + P.price('quarterly_monthly_ach') + ' per month for three months.</li>' +
      '<li><strong>Month-to-Month:</strong> ' + P.price('monthly_ach') + ' per month, continues until cancelled.</li>' +
      '</ul>' +
      '<p>Credit card payments add a ' + P.ccSurchargePct + '% processing fee. ACH and bank transfer payments have no added fee. All prices are in US dollars. The Client\'s chosen plan is recorded in Moonraker\'s client management system at the time of signing.</p>';

    html += '<h4>Performance Guarantee</h4>' +
      '<p>The Performance Guarantee is available exclusively to Clients on an annual commitment plan (Annual Paid Upfront, Annual Paid Quarterly, or Annual Paid Monthly). It is not available on quarterly or month-to-month plans.</p>' +
      '<p><strong>How it works.</strong> After the intro call, the specific benchmark is determined collaboratively between the Client and Moonraker using the Client\'s practice metrics: average client lifetime value, consultation-to-client conversion rate, call-to-consultation rate, and consultation target. Once agreed, the benchmark is captured in a separate <strong>Signed Performance Guarantee</strong> document which both parties sign. That signed document is the controlling instrument for the guarantee terms.</p>' +
      '<p><strong>The guarantee.</strong> If Moonraker does not achieve the agreed benchmark within 12 months from the signing date of the Signed Performance Guarantee, Moonraker will continue delivering the Services at no additional cost until the benchmark is achieved.</p>' +
      '<p><strong>Scope.</strong> The Performance Guarantee counts only consultations originating from organic channels: Google Search, Google Maps, and AI Search. Consultations from paid advertising, referrals, or other sources do not count toward the benchmark. The Client agrees to grant Moonraker access to relevant systems (website analytics and booking platforms) so performance can be tracked accurately.</p>' +
      '<p>If the Client upgrades from a non-commitment plan to an annual plan mid-engagement, the guarantee becomes available from that point forward and a new Signed Performance Guarantee is issued with the new 12-month window.</p>';

    html += '<h4>Additional Services & Add-ons</h4>' +
      '<p>The following add-on services are available outside the base CORE Marketing Campaign and are billed separately. Availability notes indicate which are restricted to active Clients versus available to anyone.</p>' +
      '<ul>' +
      '<li><strong>Additional Service Page:</strong> ' + P.price('additional_service_page_ach') + ' per page, beyond the 5 included in the CORE Marketing Campaign.</li>' +
      '<li><strong>Additional Press Release:</strong> ' + P.price('additional_press_release_ach') + ' per release.</li>' +
      '<li><strong>NAP Update (Name, Address, or Phone change with citation rebuild):</strong> ' + P.price('nap_update_ach') + ' per change. Update your practice contact info across your website, local directories, and citation data aggregators.</li>' +
      '</ul>' +
      '<p>Add-ons purchased by active Clients do not alter the Client\'s plan, commitment terms, or Performance Guarantee. Additional pages purchased as add-ons are built to completion but are not added to the Client\'s tracked keyword set or ongoing reporting scope unless explicitly agreed in writing. Excessive revision requests or work orders outside the Agreement may incur additional fees.</p>';

    html += '<h4>Commitment & Cancellation</h4>' +
      '<p><strong>Annual commitment plans.</strong> Clients on annual plans (Annual Paid Upfront, Annual Paid Quarterly, Annual Paid Monthly) agree to a 12-month commitment. The Client may cancel in writing at any time, subject to the early termination fee below. Moonraker will complete all deliverables for the current billing cycle before offboarding.</p>' +
      '<p><strong>Early termination fee (annual commitments).</strong> If the Client cancels an annual plan before the 12-month commitment is complete, the Client agrees to pay 50% of the remaining unbilled balance on the original plan. Example: a Client on the Annual Paid Quarterly plan who cancels after the first quarterly payment has ' + P.priceExpr('annual_quarterly_ach', 3) + ' in unbilled balance and owes a ' + P.priceExpr('annual_quarterly_ach', 1.5) + ' early termination fee. The Annual Paid Upfront plan has no unbilled balance and therefore no early termination fee; however, amounts already paid under the upfront plan are non-refundable regardless of when cancellation occurs, consistent with the Refund Policy below.</p>' +
      '<p><strong>Non-commitment plans.</strong> The Quarterly Upfront, Quarterly Paid Monthly, and Month-to-Month plans may be cancelled at any time in writing with no early termination fee. Cancellation takes effect at the end of the current billing period, and Moonraker completes deliverables for that period before offboarding.</p>' +
      '<p><strong>Cancellation process.</strong> Submit a written cancellation request to support@moonraker.ai. For annual commitment cancellations, Moonraker will issue a termination invoice for the early termination fee; the Client\'s recurring subscription (if any) is cancelled once that invoice is paid. All Client-owned assets (website content, copy, images, analytics access, and Google Business Profile ownership) remain with the Client after offboarding.</p>';

    html += '<h4>Refund Policy</h4>' +
      '<p>The Client acknowledges and agrees that no refunds will be provided by Moonraker for any work that has been completed in accordance with the Agreement. All payments made to Moonraker are final and non-refundable, regardless of the Client\'s satisfaction with the outcomes of the Services rendered.</p>';

    html += '<h4>Statement of Work</h4>' +
      '<p>The following services are included in your <span class="dynamic-field">' + planLabel + '</span>:</p>' +
      '<ul>' +
      '<li>Comprehensive entity audit using Moonraker\'s proprietary Surge platform to benchmark your digital presence</li>' +
      '<li>Project setup, tracking, and baseline reporting</li>' +
      '<li>Google Assets configuration (GBP, GA4, GSC, GTM)</li>' +
      '<li>Keyword and entities research</li>' +
      '<li>Website speed, security, and technical optimization</li>' +
      '<li>Conversion rate optimization (Hero section and calls to action)</li>' +
      '<li>5 dedicated service pages with custom HTML, schema markup, and targeted FAQ sections</li>' +
      '<li>Professional bio page creation for each therapist</li>' +
      '<li>General FAQ page</li>' +
      '<li>1 location page</li>' +
      '<li>Google Business Profile optimization</li>' +
      '<li>Citation audit and listings management via BrightLocal (15 citations + data aggregators)</li>' +
      '<li>Press release syndication across 500+ national and international news outlets (1 included, additional at ' + P.price('additional_press_release_ach') + ' each)</li>' +
      '<li>Entity Veracity Hub deployment to establish a verified knowledge base for your practice</li>' +
      '<li>LiveDrive local signal deployment</li>' +
      '<li>Rising Tide social profile buildout and optimization across up to 9 platforms (YouTube, LinkedIn, Facebook, Instagram, Quora, Pinterest, TikTok, X, and Google Business Profile)</li>' +
      '<li>2 posts per month across 4 platforms: Google Business Profile, Facebook, LinkedIn, and Quora</li>' +
      '<li>NEO image creation and distribution across high-authority platforms</li>' +
      '<li>YouTube channel creation and optimization with a curated playlist for your primary specialty</li>' +
      '<li>Professional endorsement collection and publication on clinician bio pages</li>' +
      '<li>Monthly campaign reporting with AI-powered insights</li>' +
      '</ul>';

    html += '<h4>Campaign Communications</h4>' +
      '<p><strong>Month 1:</strong> Reporting on all completed deliverables as the campaign is launched, content approval request, and weekly campaign updates.</p>' +
      '<p><strong>Month 2 Onward:</strong> Automated monthly reporting on analytics and deliverables, with the ability to chat with your results for deeper insights.</p>';

    html += '<h4>Client Responsibilities</h4>' +
      '<ul>' +
      '<li><strong>Complete Campaign Onboarding:</strong> The Client agrees to provide all requested information in the Client Onboarding dashboard in a thorough and exhaustive manner so that Moonraker can launch the Services without delay.</li>' +
      '<li><strong>Provide Access to Website and Google Properties:</strong> The Client agrees to provide access to their website, Google Business Profile (GBP) listing and other Google properties including Google Analytics (GA4), Google Search Console (GSC), and Google Tag Manager (GTM), if available.</li>' +
      '<li><strong>Provide Access to Historical SEO Data and Tools:</strong> The Client agrees to provide access to previous SEO tools or accounts for Moonraker to analyze past performance and make informed strategy decisions.</li>' +
      '<li><strong>Approve Campaign Content in a Timely Manner:</strong> The Client will respond to content approval requests from Moonraker within 48 hours, either with approval or a request for updates. If the Client does not respond within 7 days, Moonraker may go ahead and publish updates on the Client\'s behalf. Changes can still be made after content goes live.</li>' +
      '</ul>';

    return html;
};

// Full render: inserts HTML into #csaDocument, prefills signature fields, wires
// the validation listeners. Used by onboarding Step 8. The signature-field
// wiring is null-guarded so renderCSA() can be called on the read-only
// /agreement page which doesn't have those fields. Note: the /agreement page
// calls buildCSAHtml() directly rather than renderCSA(), since it never signs.
window.renderCSA = function(contactParam, pricingParam) {
    var contact = contactParam || window._onboardingContact || {};
    var html = window.buildCSAHtml(contact, pricingParam);
    var clientName = (contact.first_name || '') + ' ' + (contact.last_name || '');
    if (contact.credentials) clientName += ', ' + contact.credentials;

    var csaDoc = document.getElementById('csaDocument');
    if (csaDoc) csaDoc.innerHTML = html;

    var sigName = document.getElementById('sigName');
    var sigEmail = document.getElementById('sigEmail');
    var sigDate = document.getElementById('sigDate');
    var sigConsent = document.getElementById('sigConsent');
    var signBtn = document.getElementById('signBtn');

    if (sigName) sigName.value = clientName.replace(/,.*/, '').trim();
    if (sigEmail) sigEmail.value = contact.email || '';
    if (sigDate) sigDate.value = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    if (sigName && sigConsent && signBtn) {
      window.validateSignFields = function() {
        var name = sigName.value.trim();
        var consent = sigConsent.checked;
        var hasSig = typeof sigHasDrawn !== 'undefined' ? sigHasDrawn : false;
        signBtn.disabled = !(consent && name.length > 1 && hasSig);
      };
      sigConsent.addEventListener('change', validateSignFields);
      sigName.addEventListener('input', validateSignFields);
    }
};
