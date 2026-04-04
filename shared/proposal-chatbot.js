// /shared/proposal-chatbot.js
// Self-contained chatbot widget for proposal pages.
// Floating button (bottom-right), dismissible tooltip, streaming Sonnet 4.6 chat.
// Include via <script src="/shared/proposal-chatbot.js"></script>

(function() {
  'use strict';

  var CHAT_API = '/api/proposal-chat';
  var TOOLTIP_KEY = 'moonraker-proposal-tooltip-dismissed';
  var CHAT_OPEN_KEY = 'moonraker-proposal-chat-open';

  // ============================================================
  // INJECT CSS
  // ============================================================
  var style = document.createElement('style');
  style.textContent = `
    .mpc-btn {
      position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999;
      width: 52px; height: 52px; border-radius: 50%;
      background: var(--color-primary, #00D47E); border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,212,126,.35);
      display: flex; align-items: center; justify-content: center;
      transition: transform .15s, box-shadow .15s;
    }
    .mpc-btn:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(0,212,126,.45); }
    .mpc-btn svg { width: 24px; height: 24px; fill: #fff; }

    /* Tooltip */
    .mpc-tooltip {
      position: fixed; bottom: 6.5rem; right: 1.5rem; z-index: 9998;
      background: var(--color-surface, #fff); border: 1px solid var(--color-border, #E2E8F0);
      border-radius: 12px; padding: .85rem 1rem; max-width: 280px;
      box-shadow: 0 8px 32px rgba(0,0,0,.1);
      animation: mpcFadeIn .4s ease;
      font-family: 'Inter', -apple-system, sans-serif;
    }
    .mpc-tooltip::after {
      content: ''; position: absolute; bottom: -8px; right: 24px;
      width: 16px; height: 16px; background: var(--color-surface, #fff);
      border-right: 1px solid var(--color-border, #E2E8F0);
      border-bottom: 1px solid var(--color-border, #E2E8F0);
      transform: rotate(45deg);
    }
    .mpc-tooltip-header { display: flex; align-items: flex-start; gap: .5rem; }
    .mpc-tooltip-icon { font-size: 1.25rem; flex-shrink: 0; line-height: 1; }
    .mpc-tooltip-text { font-size: .82rem; color: var(--color-body, #333F70); line-height: 1.5; flex: 1; }
    .mpc-tooltip-text strong { color: var(--color-heading, #1E2A5E); font-weight: 600; }
    .mpc-tooltip-close {
      position: absolute; top: .5rem; right: .5rem;
      background: none; border: none; cursor: pointer;
      color: var(--color-muted, #6B7599); font-size: 1rem; line-height: 1; padding: .15rem;
    }
    .mpc-tooltip-close:hover { color: var(--color-heading, #1E2A5E); }
    .mpc-tooltip.hidden { display: none; }

    /* Chat Panel */
    .mpc-panel {
      position: fixed; bottom: 5rem; right: 1.5rem; z-index: 9998;
      width: 400px; height: 520px; max-height: calc(100vh - 7rem);
      background: var(--color-surface, #fff);
      border: 1px solid var(--color-border, #E2E8F0);
      border-radius: 16px;
      box-shadow: 0 12px 48px rgba(0,0,0,.12);
      display: none; flex-direction: column;
      animation: mpcSlideUp .25s ease;
      font-family: 'Inter', -apple-system, sans-serif;
      overflow: hidden;
    }
    .mpc-panel.open { display: flex; }

    .mpc-header {
      padding: .75rem 1rem; display: flex; align-items: center; gap: .6rem;
      border-bottom: 1px solid var(--color-border, #E2E8F0); flex-shrink: 0;
    }
    .mpc-header-icon {
      width: 32px; height: 32px; border-radius: 8px;
      background: var(--color-primary-subtle, #DDF8F2);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .mpc-header-icon img { width: 20px; height: 20px; object-fit: contain; }
    .mpc-header-info { flex: 1; }
    .mpc-header-title {
      font-family: 'Outfit', sans-serif; font-weight: 600;
      font-size: .88rem; color: var(--color-heading, #1E2A5E);
    }
    .mpc-header-sub { font-size: .68rem; color: var(--color-muted, #6B7599); }
    .mpc-close {
      width: 32px; height: 32px; border-radius: 8px;
      border: none; cursor: pointer; background: none;
      color: var(--color-muted, #6B7599); font-size: 1.1rem;
      display: flex; align-items: center; justify-content: center;
    }
    .mpc-close:hover { background: var(--color-bg, #F7FDFB); color: var(--color-heading, #1E2A5E); }

    .mpc-messages {
      flex: 1; overflow-y: auto; padding: 1rem;
      display: flex; flex-direction: column; gap: .65rem;
    }

    .mpc-msg { display: flex; max-width: 88%; animation: mpcFadeIn .2s ease; }
    .mpc-msg-user { align-self: flex-end; }
    .mpc-msg-ai { align-self: flex-start; }

    .mpc-msg-bubble {
      padding: .55rem .8rem; border-radius: 12px;
      font-size: .84rem; line-height: 1.6;
      color: var(--color-body, #333F70);
    }
    .mpc-msg-ai .mpc-msg-bubble { background: var(--color-bg, #F7FDFB); border: 1px solid var(--color-border, #E2E8F0); }
    .mpc-msg-user .mpc-msg-bubble { background: var(--color-primary, #00D47E); color: #0a1e14; border-radius: 12px 12px 4px 12px; }
    .mpc-msg-bubble p { margin: 0 0 .4rem; }
    .mpc-msg-bubble p:last-child { margin-bottom: 0; }
    .mpc-msg-bubble a { color: var(--color-primary, #00D47E); text-decoration: underline; }

    .mpc-msg-ai.streaming .mpc-msg-bubble::after {
      content: ''; display: inline-block; width: 6px; height: 14px;
      background: var(--color-primary, #00D47E); border-radius: 1px;
      animation: mpcBlink .6s step-end infinite; margin-left: 2px; vertical-align: text-bottom;
    }

    /* Welcome */
    .mpc-welcome {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 1.5rem; text-align: center; gap: .75rem;
    }
    .mpc-welcome-icon { font-size: 2rem; }
    .mpc-welcome h3 {
      font-family: 'Outfit', sans-serif; font-size: 1rem;
      font-weight: 600; color: var(--color-heading, #1E2A5E); margin: 0;
    }
    .mpc-welcome p { font-size: .82rem; color: var(--color-muted, #6B7599); margin: 0; line-height: 1.5; }
    .mpc-welcome-chips { display: flex; flex-wrap: wrap; gap: .35rem; justify-content: center; margin-top: .5rem; }
    .mpc-chip {
      padding: .35rem .65rem; border-radius: 8px; font-size: .75rem;
      border: 1px solid var(--color-border, #E2E8F0); background: var(--color-surface, #fff);
      color: var(--color-body, #333F70); cursor: pointer; transition: all .15s;
      font-family: inherit;
    }
    .mpc-chip:hover { border-color: var(--color-primary, #00D47E); color: var(--color-primary, #00D47E); background: var(--color-primary-subtle, #DDF8F2); }

    /* Input */
    .mpc-input-area {
      padding: .65rem .75rem; border-top: 1px solid var(--color-border, #E2E8F0); flex-shrink: 0;
    }
    .mpc-input-wrap { display: flex; gap: .35rem; align-items: flex-end; }
    .mpc-input {
      flex: 1; padding: .5rem .65rem; border-radius: 10px;
      border: 1px solid var(--color-border, #E2E8F0);
      background: var(--color-bg, #F7FDFB);
      color: var(--color-body, #333F70);
      font-family: 'Inter', sans-serif; font-size: .84rem;
      resize: none; outline: none; max-height: 100px; min-height: 36px; line-height: 1.4;
    }
    .mpc-input:focus { border-color: var(--color-primary, #00D47E); }
    .mpc-input::placeholder { color: var(--color-muted, #6B7599); }
    .mpc-send {
      width: 36px; height: 36px; border-radius: 8px;
      background: var(--color-primary, #00D47E); border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      transition: opacity .1s;
    }
    .mpc-send:disabled { opacity: .4; cursor: not-allowed; }
    .mpc-send svg { width: 16px; height: 16px; fill: #0a1e14; }

    @keyframes mpcFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes mpcSlideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes mpcBlink { 50% { opacity: 0; } }

    @media (max-width: 480px) {
      .mpc-panel { width: calc(100vw - 1.5rem); right: .75rem; bottom: 4.5rem; height: calc(100vh - 6rem); }
      .mpc-btn { bottom: 1rem; right: 1rem; width: 46px; height: 46px; }
      .mpc-tooltip { right: 1rem; bottom: 4.5rem; max-width: calc(100vw - 2rem); }
    }

    @media print { .mpc-btn, .mpc-panel, .mpc-tooltip { display: none !important; } }
  `;
  document.head.appendChild(style);

  // ============================================================
  // BUILD UI
  // ============================================================

  // Tooltip
  var tooltip = document.createElement('div');
  tooltip.className = 'mpc-tooltip';
  var dismissed = false;
  try { dismissed = localStorage.getItem(TOOLTIP_KEY) === '1'; } catch(e) {}
  if (dismissed) tooltip.className += ' hidden';
  tooltip.innerHTML = '<button class="mpc-tooltip-close" id="mpcTooltipClose">&times;</button>' +
    '<div class="mpc-tooltip-header">' +
    '<span class="mpc-tooltip-icon">&#128172;</span>' +
    '<div class="mpc-tooltip-text"><strong>Have questions about your proposal?</strong><br>I can help explain any section, the service agreement, pricing options, or what to expect. Just ask!</div>' +
    '</div>';
  document.body.appendChild(tooltip);

  // Floating button
  var btn = document.createElement('button');
  btn.className = 'mpc-btn';
  btn.setAttribute('aria-label', 'Chat about your proposal');
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
  document.body.appendChild(btn);

  // Chat panel
  var panel = document.createElement('div');
  panel.className = 'mpc-panel';
  panel.id = 'mpcPanel';
  panel.innerHTML =
    '<div class="mpc-header">' +
      '<div class="mpc-header-icon"><img src="/assets/logo.png" alt="M"></div>' +
      '<div class="mpc-header-info"><div class="mpc-header-title">Proposal Assistant</div><div class="mpc-header-sub">Powered by Claude</div></div>' +
      '<button class="mpc-close" id="mpcClose">&times;</button>' +
    '</div>' +
    '<div class="mpc-messages" id="mpcMessages">' +
      '<div class="mpc-welcome" id="mpcWelcome">' +
        '<div class="mpc-welcome-icon">&#128075;</div>' +
        '<h3>Hi! I\'m your Proposal Assistant</h3>' +
        '<p>I can answer questions about your proposal, the service agreement, pricing, timeline, or anything else you\'re curious about.</p>' +
        '<div class="mpc-welcome-chips">' +
          '<button class="mpc-chip" data-q="What exactly will Moonraker do for my practice?">What\'s included</button>' +
          '<button class="mpc-chip" data-q="How does the CORE framework work?">CORE framework</button>' +
          '<button class="mpc-chip" data-q="How does payment work for my plan?">Payment</button>' +
          '<button class="mpc-chip" data-q="What happens after I sign up?">Next steps</button>' +
          '<button class="mpc-chip" data-q="Can I cancel if I need to?">Cancellation</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="mpc-input-area">' +
      '<div class="mpc-input-wrap">' +
        '<textarea class="mpc-input" id="mpcInput" rows="1" placeholder="Ask about your proposal..."></textarea>' +
        '<button class="mpc-send" id="mpcSend"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(panel);

  // ============================================================
  // STATE
  // ============================================================
  var messages = [];
  var isStreaming = false;
  var pageContent = '';

  // Extract page content for context
  function extractPageContent() {
    var main = document.querySelector('.container') || document.body;
    var text = main.innerText || main.textContent || '';
    // Clean up and truncate
    text = text.replace(/\s+/g, ' ').trim();
    return text.substring(0, 10000);
  }

  // Get slug from URL
  function getSlug() {
    var parts = window.location.pathname.replace(/^\/|\/$/g, '').split('/');
    return parts[0] || '';
  }

  // ============================================================
  // EVENT HANDLERS
  // ============================================================

  // Tooltip dismiss
  document.getElementById('mpcTooltipClose').addEventListener('click', function(e) {
    e.stopPropagation();
    tooltip.classList.add('hidden');
    try { localStorage.setItem(TOOLTIP_KEY, '1'); } catch(e) {}
  });

  // Toggle chat
  btn.addEventListener('click', function() {
    var isOpen = panel.classList.contains('open');
    if (isOpen) {
      panel.classList.remove('open');
    } else {
      panel.classList.add('open');
      tooltip.classList.add('hidden');
      try { localStorage.setItem(TOOLTIP_KEY, '1'); } catch(e) {}
      if (!pageContent) pageContent = extractPageContent();
      var input = document.getElementById('mpcInput');
      if (input) setTimeout(function() { input.focus(); }, 200);
    }
  });

  // Close button
  document.getElementById('mpcClose').addEventListener('click', function() {
    panel.classList.remove('open');
  });

  // Chip clicks
  panel.addEventListener('click', function(e) {
    var chip = e.target.closest('.mpc-chip');
    if (chip && chip.dataset.q) {
      document.getElementById('mpcInput').value = chip.dataset.q;
      sendMessage();
    }
  });

  // Send button
  document.getElementById('mpcSend').addEventListener('click', sendMessage);

  // Enter key
  document.getElementById('mpcInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Auto-resize textarea
  document.getElementById('mpcInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });

  // ============================================================
  // CHAT LOGIC
  // ============================================================

  function sendMessage() {
    var input = document.getElementById('mpcInput');
    var text = input.value.trim();
    if (!text || isStreaming) return;

    input.value = '';
    input.style.height = 'auto';

    // Hide welcome
    var welcome = document.getElementById('mpcWelcome');
    if (welcome) welcome.style.display = 'none';

    // Add user message
    addMessage('user', text);
    messages.push({ role: 'user', content: text });

    // Stream AI response
    streamResponse();
  }

  function addMessage(role, content) {
    var container = document.getElementById('mpcMessages');
    var div = document.createElement('div');
    div.className = 'mpc-msg mpc-msg-' + (role === 'user' ? 'user' : 'ai');
    div.innerHTML = '<div class="mpc-msg-bubble">' + formatContent(content) + '</div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }

  function formatContent(text) {
    if (!text) return '';
    // Basic markdown-ish formatting
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    // Paragraphs
    var paras = text.split(/\n\n+/);
    if (paras.length > 1) {
      text = paras.map(function(p) { return '<p>' + p.trim() + '</p>'; }).join('');
    }
    return text;
  }

  async function streamResponse() {
    isStreaming = true;
    document.getElementById('mpcSend').disabled = true;

    var container = document.getElementById('mpcMessages');
    var aiDiv = document.createElement('div');
    aiDiv.className = 'mpc-msg mpc-msg-ai streaming';
    aiDiv.innerHTML = '<div class="mpc-msg-bubble"></div>';
    container.appendChild(aiDiv);
    container.scrollTop = container.scrollHeight;

    var bubble = aiDiv.querySelector('.mpc-msg-bubble');
    var fullText = '';
    var displayedLen = 0;
    var renderTimer = null;

    // Adaptive typewriter: smooth when close to live edge, fast catch-up on bursts
    function startTypewriter() {
      if (renderTimer) return;
      renderTimer = setInterval(function() {
        if (displayedLen < fullText.length) {
          var backlog = fullText.length - displayedLen;
          // Scale speed: 1-2 chars when nearly caught up, up to 8 when far behind
          var step = backlog > 200 ? 8 : backlog > 80 ? 5 : backlog > 30 ? 3 : backlog > 10 ? 2 : 1;
          displayedLen += step;
          if (displayedLen > fullText.length) displayedLen = fullText.length;
          bubble.innerHTML = formatContent(fullText.substring(0, displayedLen));
        } else {
          clearInterval(renderTimer);
          renderTimer = null;
        }
      }, 16); // ~60fps
    }
    try {
      var resp = await fetch(CHAT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages,
          context: { page_content: pageContent, slug: getSlug() }
        })
      });

      if (!resp.ok) {
        bubble.textContent = 'Sorry, I had trouble connecting. Please try again.';
        aiDiv.classList.remove('streaming');
        isStreaming = false;
        document.getElementById('mpcSend').disabled = false;
        return;
      }

      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        var lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (var line of lines) {
          if (line.startsWith('data: ')) {
            var data = line.substring(6).trim();
            if (data === '[DONE]') continue;
            try {
              var parsed = JSON.parse(data);
              if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
                fullText += parsed.delta.text;
                startTypewriter();
              } else if (parsed.type === 'message_stop') {
                break;
              }
            } catch(e) {}
          }
        }
      }
      // Wait for typewriter to finish rendering remaining chars
      if (renderTimer) clearInterval(renderTimer);
      bubble.innerHTML = formatContent(fullText);
    } catch(e) {
      if (!fullText) bubble.textContent = 'Sorry, something went wrong. Please try again.';
    }

    aiDiv.classList.remove('streaming');
    messages.push({ role: 'assistant', content: fullText });
    isStreaming = false;
    document.getElementById('mpcSend').disabled = false;
  }

  // Auto-dismiss tooltip after 10 seconds
  if (!dismissed) {
    setTimeout(function() {
      if (!tooltip.classList.contains('hidden')) {
        tooltip.style.transition = 'opacity .5s ease';
        tooltip.style.opacity = '0';
        setTimeout(function() { tooltip.classList.add('hidden'); tooltip.style.opacity = ''; }, 500);
      }
    }, 12000);
  }

})();



