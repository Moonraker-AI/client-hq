// /shared/proposal-chatbot.js
// Self-contained chatbot widget for proposal pages.
// Floating button (bottom-right), dismissible tooltip, streaming Sonnet 4.6 chat.
// Include via <script src="/shared/proposal-chatbot.js"></script>

(function() {
  'use strict';

  var pageContent = '';

  function extractPageContent() {
    var main = document.querySelector('.container') || document.body;
    var text = main.innerText || main.textContent || '';
    text = text.replace(/\s+/g, ' ').trim();
    return text.substring(0, 10000);
  }

  function getSlug() {
    var parts = window.location.pathname.replace(/^\/|\/$/g, '').split('/');
    return parts[0] || '';
  }

  function init() {
    window.MoonrakerChatbot({
      prefix: 'mpc',
      apiUrl: '/api/proposal-chat',
      tooltipKey: 'moonraker-proposal-tooltip-dismissed',
      btnTitle: 'Chat about your proposal',
      title: 'Proposal Assistant',
      subtitle: 'Powered by Claude Sonnet 4.6',
      tooltipIcon: '&#128172;',
      tooltipHtml: '<strong>Have questions about your proposal?</strong><br>I can help explain any section, the service agreement, pricing options, or what to expect. Just ask!',
      welcomeIcon: '&#128075;',
      welcomeTitle: "Hi! I'm your Proposal Assistant",
      welcomeText: "I can answer questions about your proposal, the service agreement, pricing, timeline, or anything else you're curious about.",
      chips: [
        { label: "What's included", question: 'What exactly will Moonraker do for my practice?' },
        { label: 'CORE framework', question: 'How does the CORE framework work?' },
        { label: 'Payment', question: 'How does payment work for my plan?' },
        { label: 'Next steps', question: 'What happens after I sign up?' },
        { label: 'Cancellation', question: 'Can I cancel if I need to?' }
      ],
      placeholder: 'Ask about your proposal...',
      headerIcon: '<img src="/assets/logo.png" alt="M">',
      onOpen: function() {
        if (!pageContent) pageContent = extractPageContent();
      },
      buildContext: function() {
        if (!pageContent) pageContent = extractPageContent();
        return {
          page_content: pageContent,
          slug: getSlug()
          // page_token removed — cookie-backed auth via /api/page-token/request
        };
      }
    });
  }

  // Auto-load base module if not already present
  if (window.MoonrakerChatbot) {
    init();
  } else {
    var s = document.createElement('script');
    s.src = '/shared/chatbot-base.js';
    s.onload = init;
    document.head.appendChild(s);
  }
})();
