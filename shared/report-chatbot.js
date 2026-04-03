// /shared/report-chatbot.js
// Self-contained chatbot widget for report pages.
// Floating button (bottom-right), dismissible tooltip, streaming Opus 4.6 chat.
// Include via <script src="/shared/report-chatbot.js"></script>
//
// Expects window.__REPORT_CHAT_CONTEXT to be set before this script loads:
//   { snapshot: {...}, highlights: [...], practice_name: "...", campaign_month: 2 }

(function() {
  'use strict';

  var CHAT_API = '/api/report-chat';
  var TOOLTIP_KEY = 'moonraker-report-tooltip-dismissed';
  var messages = [];
  var isStreaming = false;
  var chatContext = window.__REPORT_CHAT_CONTEXT || {};

  // ============================================================
  // INJECT CSS
  // ============================================================
  var style = document.createElement('style');
  style.textContent = `
    .mrc-btn {
      position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999;
      width: 52px; height: 52px; border-radius: 50%;
      background: var(--color-primary, #00D47E); border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,212,126,.35);
      display: flex; align-items: center; justify-content: center;
      transition: transform .15s, box-shadow .15s;
    }
    .mrc-btn:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(0,212,126,.45); }
    .mrc-btn svg { width: 24px; height: 24px; fill: #fff; }

    .mrc-tooltip {
      position: fixed; bottom: 6.5rem; right: 1.5rem; z-index: 9998;
      background: var(--color-surface, #fff); border: 1px solid var(--color-border, #E2E8F0);
      border-radius: 12px; padding: .85rem 1rem; max-width: 280px;
      box-shadow: 0 8px 32px rgba(0,0,0,.1);
      animation: mrcFadeIn .4s ease;
      font-family: 'Inter', -apple-system, sans-serif;
    }
    .mrc-tooltip::after {
      content: ''; position: absolute; bottom: -8px; right: 24px;
      width: 16px; height: 16px; background: var(--color-surface, #fff);
      border-right: 1px solid var(--color-border, #E2E8F0);
      border-bottom: 1px solid var(--color-border, #E2E8F0);
      transform: rotate(45deg);
    }
    .mrc-tooltip-header { display: flex; align-items: flex-start; gap: .5rem; }
    .mrc-tooltip-icon { font-size: 1.25rem; flex-shrink: 0; line-height: 1; }
    .mrc-tooltip-text { font-size: .82rem; color: var(--color-body, #333F70); line-height: 1.5; flex: 1; }
    .mrc-tooltip-text strong { color: var(--color-heading, #1E2A5E); font-weight: 600; }
    .mrc-tooltip-close {
      position: absolute; top: .5rem; right: .5rem;
      background: none; border: none; cursor: pointer;
      color: var(--color-muted, #6B7599); font-size: 1rem; line-height: 1; padding: .15rem;
    }
    .mrc-tooltip-close:hover { color: var(--color-heading, #1E2A5E); }
    .mrc-tooltip.hidden { display: none; }

    .mrc-panel {
      position: fixed; bottom: 5rem; right: 1.5rem; z-index: 9998;
      width: 400px; height: 520px; max-height: calc(100vh - 7rem);
      background: var(--color-surface, #fff);
      border: 1px solid var(--color-border, #E2E8F0);
      border-radius: 16px;
      box-shadow: 0 12px 48px rgba(0,0,0,.12);
      display: none; flex-direction: column;
      animation: mrcSlideUp .25s ease;
      font-family: 'Inter', -apple-system, sans-serif;
      overflow: hidden;
    }
    .mrc-panel.open { display: flex; }

    .mrc-header {
      padding: .75rem 1rem; display: flex; align-items: center; gap: .6rem;
      border-bottom: 1px solid var(--color-border, #E2E8F0); flex-shrink: 0;
    }
    .mrc-header-icon {
      width: 32px; height: 32px; border-radius: 8px;
      background: var(--color-primary-subtle, #DDF8F2);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .mrc-header-icon img { width: 20px; height: 20px; object-fit: contain; }
    .mrc-header-info { flex: 1; }
    .mrc-header-title {
      font-family: 'Outfit', sans-serif; font-weight: 600;
      font-size: .88rem; color: var(--color-heading, #1E2A5E);
    }
    .mrc-header-sub { font-size: .68rem; color: var(--color-muted, #6B7599); }
    .mrc-close {
      width: 32px; height: 32px; border-radius: 8px;
      border: none; cursor: pointer; background: none;
      color: var(--color-muted, #6B7599); font-size: 1.1rem;
      display: flex; align-items: center; justify-content: center;
    }
    .mrc-close:hover { background: var(--color-bg, #F7FDFB); color: var(--color-heading, #1E2A5E); }

    .mrc-messages {
      flex: 1; overflow-y: auto; padding: 1rem;
      display: flex; flex-direction: column; gap: .65rem;
    }

    .mrc-msg { display: flex; max-width: 88%; animation: mrcFadeIn .2s ease; }
    .mrc-msg-user { align-self: flex-end; }
    .mrc-msg-ai { align-self: flex-start; }

    .mrc-msg-bubble {
      padding: .55rem .8rem; border-radius: 12px;
      font-size: .84rem; line-height: 1.6;
      color: var(--color-body, #333F70);
    }
    .mrc-msg-ai .mrc-msg-bubble { background: var(--color-bg, #F7FDFB); border: 1px solid var(--color-border, #E2E8F0); }
    .mrc-msg-user .mrc-msg-bubble { background: var(--color-primary, #00D47E); color: #0a1e14; border-radius: 12px 12px 4px 12px; }
    .mrc-msg-bubble p { margin: 0 0 .4rem; }
    .mrc-msg-bubble p:last-child { margin-bottom: 0; }
    .mrc-msg-bubble a { color: var(--color-primary, #00D47E); text-decoration: underline; }

    .mrc-msg-ai.streaming .mrc-msg-bubble::after {
      content: ''; display: inline-block; width: 6px; height: 14px;
      background: var(--color-primary, #00D47E); border-radius: 1px;
      animation: mrcBlink .6s step-end infinite; margin-left: 2px; vertical-align: text-bottom;
    }

    .mrc-welcome {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 1.5rem; text-align: center; gap: .75rem;
    }
    .mrc-welcome-icon { font-size: 2rem; }
    .mrc-welcome h3 {
      font-family: 'Outfit', sans-serif; font-size: 1rem;
      font-weight: 600; color: var(--color-heading, #1E2A5E); margin: 0;
    }
    .mrc-welcome p { font-size: .82rem; color: var(--color-muted, #6B7599); margin: 0; line-height: 1.5; }
    .mrc-welcome-chips { display: flex; flex-wrap: wrap; gap: .35rem; justify-content: center; margin-top: .5rem; }
    .mrc-chip {
      padding: .35rem .65rem; border-radius: 8px; font-size: .75rem;
      border: 1px solid var(--color-border, #E2E8F0); background: var(--color-surface, #fff);
      color: var(--color-body, #333F70); cursor: pointer; transition: all .15s;
      font-family: inherit;
    }
    .mrc-chip:hover { border-color: var(--color-primary, #00D47E); color: var(--color-primary, #00D47E); background: var(--color-primary-subtle, #DDF8F2); }

    .mrc-input-area {
      padding: .65rem .75rem; border-top: 1px solid var(--color-border, #E2E8F0); flex-shrink: 0;
    }
    .mrc-input-wrap { display: flex; gap: .35rem; align-items: flex-end; }
    .mrc-input {
      flex: 1; padding: .5rem .65rem; border-radius: 10px;
      border: 1px solid var(--color-border, #E2E8F0);
      background: var(--color-bg, #F7FDFB);
      color: var(--color-body, #333F70);
      font-family: 'Inter', sans-serif; font-size: .84rem;
      resize: none; outline: none; max-height: 100px; min-height: 36px; line-height: 1.4;
    }
    .mrc-input:focus { border-color: var(--color-primary, #00D47E); }
    .mrc-input::placeholder { color: var(--color-muted, #6B7599); }
    .mrc-send {
      width: 36px; height: 36px; border-radius: 8px;
      background: var(--color-primary, #00D47E); border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      transition: opacity .1s;
    }
    .mrc-send:disabled { opacity: .4; cursor: not-allowed; }
    .mrc-send svg { width: 16px; height: 16px; fill: #0a1e14; }

    @keyframes mrcFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes mrcSlideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes mrcBlink { 50% { opacity: 0; } }

    @media (max-width: 480px) {
      .mrc-panel { width: calc(100vw - 1.5rem); right: .75rem; bottom: 4.5rem; height: calc(100vh - 6rem); }
      .mrc-btn { bottom: 1rem; right: 1rem; width: 46px; height: 46px; }
      .mrc-tooltip { right: 1rem; bottom: 4.5rem; max-width: calc(100vw - 2rem); }
    }

    @media print { .mrc-btn, .mrc-panel, .mrc-tooltip { display: none !important; } }
  `;
  document.head.appendChild(style);

  // ============================================================
  // BUILD UI
  // ============================================================

  // Tooltip
  var tooltip = document.createElement('div');
  tooltip.className = 'mrc-tooltip';
  var dismissed = false;
  try { dismissed = localStorage.getItem(TOOLTIP_KEY) === '1'; } catch(e) {}
  if (dismissed) tooltip.className += ' hidden';
  tooltip.innerHTML = '<button class="mrc-tooltip-close" id="mrcTooltipClose">&times;</button>' +
    '<div class="mrc-tooltip-header">' +
    '<span class="mrc-tooltip-icon">&#128202;</span>' +
    '<div class="mrc-tooltip-text"><strong>Have questions about your report?</strong><br>I can explain any metric, walk you through what the data means for your practice, and answer questions about your campaign.</div>' +
    '</div>';
  document.body.appendChild(tooltip);

  // Floating button
  var btn = document.createElement('button');
  btn.className = 'mrc-btn';
  btn.title = 'Ask about your report';
  btn.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>';
  document.body.appendChild(btn);

  // Chat panel
  var panel = document.createElement('div');
  panel.className = 'mrc-panel';
  panel.id = 'mrcPanel';

  var practiceName = chatContext.practice_name || 'your practice';
  var month = chatContext.campaign_month || '';

  panel.innerHTML = '<div class="mrc-header">' +
    '<div class="mrc-header-icon"><img src="/assets/logo.png" alt="Moonraker"></div>' +
    '<div class="mrc-header-info">' +
    '<div class="mrc-header-title">Report Assistant</div>' +
    '<div class="mrc-header-sub">Powered by Claude Opus</div>' +
    '</div>' +
    '<button class="mrc-close" id="mrcClose">&times;</button>' +
    '</div>' +
    '<div class="mrc-messages" id="mrcMessages">' +
    '<div class="mrc-welcome" id="mrcWelcome">' +
    '<span class="mrc-welcome-icon">&#128202;</span>' +
    '<h3>Hi! I can help explain your report.</h3>' +
    '<p>Ask me anything about your campaign performance, what the metrics mean, or what we are working on next.</p>' +
    '<div class="mrc-welcome-chips">' +
    '<button class="mrc-chip" data-q="How is my website performing this month?">Website performance</button>' +
    '<button class="mrc-chip" data-q="Which AI platforms recommend my practice?">AI visibility</button>' +
    '<button class="mrc-chip" data-q="How visible am I on Google Maps?">Maps ranking</button>' +
    '<button class="mrc-chip" data-q="What are you working on to improve my visibility?">Current work</button>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="mrc-input-area">' +
    '<div class="mrc-input-wrap">' +
    '<textarea class="mrc-input" id="mrcInput" placeholder="Ask about your report..." rows="1"></textarea>' +
    '<button class="mrc-send" id="mrcSend"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(panel);

  // ============================================================
  // EVENT HANDLERS
  // ============================================================

  // Dismiss tooltip
  document.getElementById('mrcTooltipClose').addEventListener('click', function() {
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
      var input = document.getElementById('mrcInput');
      if (input) setTimeout(function() { input.focus(); }, 200);
    }
  });

  // Close button
  document.getElementById('mrcClose').addEventListener('click', function() {
    panel.classList.remove('open');
  });

  // Chip clicks
  panel.addEventListener('click', function(e) {
    var chip = e.target.closest('.mrc-chip');
    if (chip && chip.dataset.q) {
      document.getElementById('mrcInput').value = chip.dataset.q;
      sendMessage();
    }
  });

  // Send button
  document.getElementById('mrcSend').addEventListener('click', sendMessage);

  // Enter key
  document.getElementById('mrcInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Auto-resize textarea
  document.getElementById('mrcInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });

  // ============================================================
  // CHAT LOGIC
  // ============================================================

  function sendMessage() {
    var input = document.getElementById('mrcInput');
    var text = input.value.trim();
    if (!text || isStreaming) return;

    input.value = '';
    input.style.height = 'auto';

    var welcome = document.getElementById('mrcWelcome');
    if (welcome) welcome.style.display = 'none';

    addMessage('user', text);
    messages.push({ role: 'user', content: text });
    streamResponse();
  }

  function addMessage(role, content) {
    var container = document.getElementById('mrcMessages');
    var div = document.createElement('div');
    div.className = 'mrc-msg mrc-msg-' + (role === 'user' ? 'user' : 'ai');
    div.innerHTML = '<div class="mrc-msg-bubble">' + formatContent(content) + '</div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }

  function formatContent(text) {
    if (!text) return '';
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    var paras = text.split(/\n\n+/);
    if (paras.length > 1) {
      text = paras.map(function(p) { return '<p>' + p.trim() + '</p>'; }).join('');
    }
    return text;
  }

  async function streamResponse() {
    isStreaming = true;
    document.getElementById('mrcSend').disabled = true;

    var container = document.getElementById('mrcMessages');
    var aiDiv = document.createElement('div');
    aiDiv.className = 'mrc-msg mrc-msg-ai streaming';
    aiDiv.innerHTML = '<div class="mrc-msg-bubble"></div>';
    container.appendChild(aiDiv);
    container.scrollTop = container.scrollHeight;

    var bubble = aiDiv.querySelector('.mrc-msg-bubble');
    var fullText = '';
    var displayedLen = 0;
    var renderTimer = null;

    function startTypewriter() {
      if (renderTimer) return;
      renderTimer = setInterval(function() {
        if (displayedLen < fullText.length) {
          var backlog = fullText.length - displayedLen;
          var step = backlog > 200 ? 8 : backlog > 80 ? 5 : backlog > 30 ? 3 : backlog > 10 ? 2 : 1;
          displayedLen += step;
          if (displayedLen > fullText.length) displayedLen = fullText.length;
          bubble.innerHTML = formatContent(fullText.substring(0, displayedLen));
        } else {
          clearInterval(renderTimer);
          renderTimer = null;
        }
      }, 16);
    }

    try {
      var resp = await fetch(CHAT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages,
          context: chatContext
        })
      });

      if (!resp.ok) {
        bubble.textContent = 'Sorry, I had trouble connecting. Please try again.';
        aiDiv.classList.remove('streaming');
        isStreaming = false;
        document.getElementById('mrcSend').disabled = false;
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

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
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

      if (renderTimer) clearInterval(renderTimer);
      bubble.innerHTML = formatContent(fullText);
    } catch(e) {
      if (!fullText) bubble.textContent = 'Sorry, something went wrong. Please try again.';
    }

    aiDiv.classList.remove('streaming');
    messages.push({ role: 'assistant', content: fullText });
    isStreaming = false;
    document.getElementById('mrcSend').disabled = false;
  }

  // Auto-dismiss tooltip after 12 seconds
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
