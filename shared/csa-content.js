// /shared/csa-content.js
// Shared CSA document builder for all onboarding pages.
// Single source of truth for the Client Service Agreement text.
// When a client signs, the rendered HTML is snapshotted into signed_agreements.document_html.
//
// Usage: <script src="/shared/csa-content.js"></script>
// Call:  renderCSA(contact)  where contact has: first_name, last_name, credentials,
//        practice_name, practice_address_line1, city, state_province, postal_code,
//        country, plan_type, email
//
// Version: 2026-04-16 (SOW aligned with actual deliverables)

window.renderCSA = function(contactParam) {
    var contact = contactParam || window._onboardingContact;
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

    html += '<h4>Performance Guarantee</h4>' +
      '<p>Moonraker will provide a performance guarantee when the Client selects a 12-month payment term. This guarantee may include, for example, a specific increase in website traffic or a designated number of booked consultation calls. The specific performance goal will be determined collaboratively by Moonraker and the Client and confirmed in writing. To accurately track performance against the guarantee, the Client agrees to grant Moonraker access to relevant systems, such as website analytics and booking platforms. Should Moonraker fail to help the Client achieve the established goal by the end of the 12-month term, Moonraker will continue providing the Services at no cost until the goal is met.</p>';

    html += '<h4>Additional Fees</h4>' +
      '<p>Any additional services requested by the Client that are not included in the Agreement will result in additional fees decided on by Moonraker. An excessive amount of work orders from the Client in relation to the Services may result in additional fees from Moonraker, including but not limited to the need to have additional work completed, multiple revisions, extensions of the Services, or additional purchase of resources.</p>';

    html += '<h4>Cancellation of Services</h4>' +
      '<p>The Client may cancel services in writing at any time. Moonraker will deactivate billing and complete all deliverables for the current billing cycle before initiating the Client offboarding process.</p>';

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
      '<li>Press release syndication across 500+ national and international news outlets (1 included, additional at $300 each)</li>' +
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

    document.getElementById('csaDocument').innerHTML = html;

    // Pre-fill signature fields
    document.getElementById('sigName').value = clientName.replace(/,.*/, '').trim();
    document.getElementById('sigEmail').value = contact.email || '';
    document.getElementById('sigDate').value = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // Enable sign button when consent + name + signature are all provided
    // validateSignFields is a global so the canvas code can call it too
    window.validateSignFields = function() {
      var name = document.getElementById('sigName').value.trim();
      var consent = document.getElementById('sigConsent').checked;
      var hasSig = typeof sigHasDrawn !== 'undefined' ? sigHasDrawn : false;
      document.getElementById('signBtn').disabled = !(consent && name.length > 1 && hasSig);
    };
    document.getElementById('sigConsent').addEventListener('change', validateSignFields);
    document.getElementById('sigName').addEventListener('input', validateSignFields);
  }
