// /shared/chatbot-base.js
// Shared chatbot widget factory for Moonraker client-facing pages.
// Creates a floating chat button, tooltip, and streaming AI chat panel.
//
// Usage:
//   <script src="/shared/chatbot-base.js"></script>
//   <script src="/shared/report-chatbot.js"></script>
//
// Or loaded dynamically by the wrapper scripts (they auto-load this file).
//
// Factory: window.MoonrakerChatbot(config) -> { addMessage, panel, messages }
//
// Config shape:
//   {
//     prefix:           'mrc',               // CSS class/animation prefix
//     apiUrl:           '/api/report-chat',   // streaming chat endpoint
//     tooltipKey:       'moonraker-...',      // localStorage key for dismiss
//     btnTitle:         'Ask about ...',      // button title/aria-label
//     btnSvg:           '<svg>...</svg>',     // optional custom SVG for button
//     title:            'Report Assistant',   // header title
//     subtitle:         'Powered by ...',     // header subtitle
//     tooltipIcon:      '&#128202;',          // emoji for tooltip
//     tooltipHtml:      '<strong>...</strong>',// tooltip body HTML
//     welcomeIcon:      '&#128202;',          // emoji for welcome screen
//     welcomeTitle:     'Hi! I can help ...',
//     welcomeText:      'Ask me anything ...',
//     chips:            [{ label, question }],// quick-action chips
//     placeholder:      'Ask about ...',      // textarea placeholder
//     buildContext:      function(msgs) {},   // returns context object for API
//     onOpen:           null,                 // optional: called when panel opens
//     onStreamComplete: null,                 // optional: function(fullText, aiDiv, helpers)
//     filterDisplay:    null,                 // optional: function(text) -> filtered text
//     headerIcon:       '<img ...>',          // inner HTML for header icon div
//     chipStyle:        'horizontal',         // 'horizontal' or 'vertical'
//     chipClass:        null,                 // override class name for chips
//     chipAttr:         'data-q',             // attribute name for chip question
//   }

(function() {
  'use strict';

  window.MoonrakerChatbot = function(config) {
    var p = config.prefix || 'mrc';
    var messages = [];
    var isStreaming = false;

    // Unique IDs based on prefix to avoid collisions
    var ids = {
      panel:        p + 'Panel',
      messages:     p + 'Messages',
      welcome:      p + 'Welcome',
      input:        p + 'Input',
      send:         p + 'Send',
      close:        p + 'Close',
      tooltipClose: p + 'TooltipClose'
    };

    var chipClass = config.chipClass || (p + '-chip');
    var chipAttr = config.chipAttr || 'data-q';
    var chipStyle = config.chipStyle || 'horizontal';

    // Default button SVG (chat bubble)
    var defaultBtnSvg = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
    var btnSvg = config.btnSvg || defaultBtnSvg;

    // Default header icon
    var headerIcon = config.headerIcon || '<img src="/assets/logo.png" alt="Moonraker">';

    // ============================================================
    // INJECT CSS
    // ============================================================
    var style = document.createElement('style');
    style.textContent = buildCSS(p, chipStyle, chipClass);
    document.head.appendChild(style);

    // ============================================================
    // BUILD UI
    // ============================================================

    // Tooltip
    var tooltip = document.createElement('div');
    tooltip.className = p + '-tooltip';
    var dismissed = false;
    try { dismissed = localStorage.getItem(config.tooltipKey) === '1'; } catch(e) {}
    if (dismissed) tooltip.className += ' hidden';
    tooltip.innerHTML = '<button class="' + p + '-tooltip-close" id="' + ids.tooltipClose + '">&times;</button>' +
      '<div class="' + p + '-tooltip-header">' +
      '<span class="' + p + '-tooltip-icon">' + (config.tooltipIcon || '&#128172;') + '</span>' +
      '<div class="' + p + '-tooltip-text">' + (config.tooltipHtml || '') + '</div>' +
      '</div>';
    document.body.appendChild(tooltip);

    // Floating button
    var btn = document.createElement('button');
    btn.className = p + '-btn';
    if (config.btnTitle) {
      btn.title = config.btnTitle;
      btn.setAttribute('aria-label', config.btnTitle);
    }
    btn.innerHTML = btnSvg;
    document.body.appendChild(btn);

    // Chat panel
    var panel = document.createElement('div');
    panel.className = p + '-panel';
    panel.id = ids.panel;

    // Build chips HTML
    var chipsHtml = '';
    var chips = config.chips || [];
    if (chipStyle === 'vertical') {
      chipsHtml = '<div class="' + p + '-suggestions" id="' + p + 'Suggestions">';
      for (var ci = 0; ci < chips.length; ci++) {
        chipsHtml += '<button class="' + chipClass + '" ' + chipAttr + '="' + escAttr(chips[ci].question) + '">' + escHtml(chips[ci].label) + '</button>';
      }
      chipsHtml += '</div>';
    } else {
      chipsHtml = '<div class="' + p + '-welcome-chips">';
      for (var ci2 = 0; ci2 < chips.length; ci2++) {
        chipsHtml += '<button class="' + chipClass + '" ' + chipAttr + '="' + escAttr(chips[ci2].question) + '">' + escHtml(chips[ci2].label) + '</button>';
      }
      chipsHtml += '</div>';
    }

    panel.innerHTML = '<div class="' + p + '-header">' +
      '<div class="' + p + '-header-icon">' + headerIcon + '</div>' +
      '<div class="' + p + '-header-info">' +
      '<div class="' + p + '-header-title">' + escHtml(config.title || 'Chat Assistant') + '</div>' +
      '<div class="' + p + '-header-sub">' + escHtml(config.subtitle || 'Powered by Claude Sonnet 4.6') + '</div>' +
      '</div>' +
      '<button class="' + p + '-close" id="' + ids.close + '">&times;</button>' +
      '</div>' +
      '<div class="' + p + '-messages" id="' + ids.messages + '">' +
      '<div class="' + p + '-welcome" id="' + ids.welcome + '">' +
      '<div class="' + p + '-welcome-icon">' + (config.welcomeIcon || '&#128075;') + '</div>' +
      '<h3>' + (config.welcomeTitle || 'How can I help?') + '</h3>' +
      '<p>' + (config.welcomeText || '') + '</p>' +
      chipsHtml +
      '</div>' +
      '</div>' +
      '<div class="' + p + '-input-area">' +
      '<div class="' + p + '-input-wrap">' +
      '<textarea class="' + p + '-input" id="' + ids.input + '" rows="1" placeholder="' + escAttr(config.placeholder || 'Type a message...') + '"></textarea>' +
      '<button class="' + p + '-send" id="' + ids.send + '"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(panel);

    // ============================================================
    // EVENT HANDLERS
    // ============================================================

    // Dismiss tooltip
    document.getElementById(ids.tooltipClose).addEventListener('click', function(e) {
      e.stopPropagation();
      tooltip.classList.add('hidden');
      try { localStorage.setItem(config.tooltipKey, '1'); } catch(ex) {}
    });

    // Toggle chat
    btn.addEventListener('click', function() {
      var isOpen = panel.classList.contains('open');
      if (isOpen) {
        panel.classList.remove('open');
      } else {
        panel.classList.add('open');
        tooltip.classList.add('hidden');
        try { localStorage.setItem(config.tooltipKey, '1'); } catch(ex) {}
        if (typeof config.onOpen === 'function') config.onOpen();
        var input = document.getElementById(ids.input);
        if (input) setTimeout(function() { input.focus(); }, 200);
      }
    });

    // Close button
    document.getElementById(ids.close).addEventListener('click', function() {
      panel.classList.remove('open');
    });

    // Chip clicks
    panel.addEventListener('click', function(e) {
      var chip = e.target.closest('.' + chipClass);
      if (chip && chip.getAttribute(chipAttr)) {
        document.getElementById(ids.input).value = chip.getAttribute(chipAttr);
        sendMessage();
      }
    });

    // Send button
    document.getElementById(ids.send).addEventListener('click', sendMessage);

    // Enter key
    document.getElementById(ids.input).addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    // Auto-resize textarea
    document.getElementById(ids.input).addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });

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

    // ============================================================
    // CHAT LOGIC
    // ============================================================

    function sendMessage() {
      var input = document.getElementById(ids.input);
      var text = input.value.trim();
      if (!text || isStreaming) return;

      input.value = '';
      input.style.height = 'auto';

      var welcome = document.getElementById(ids.welcome);
      if (welcome) welcome.style.display = 'none';

      addMessage('user', text);
      messages.push({ role: 'user', content: text });
      streamResponse();
    }

    function addMessage(role, content, extra) {
      var container = document.getElementById(ids.messages);
      var div = document.createElement('div');
      div.className = p + '-msg ' + p + '-msg-' + (role === 'user' ? 'user' : 'ai');
      var html = '<div class="' + p + '-msg-bubble">' + formatContent(content) + '</div>';
      if (extra) html += extra;
      div.innerHTML = html;
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
        text = paras.map(function(para) { return '<p>' + para.trim() + '</p>'; }).join('');
      }
      return text;
    }

    async function streamResponse() {
      isStreaming = true;
      document.getElementById(ids.send).disabled = true;

      var container = document.getElementById(ids.messages);
      var aiDiv = document.createElement('div');
      aiDiv.className = p + '-msg ' + p + '-msg-ai streaming';
      aiDiv.innerHTML = '<div class="' + p + '-msg-bubble"></div>';
      container.appendChild(aiDiv);
      container.scrollTop = container.scrollHeight;

      var bubble = aiDiv.querySelector('.' + p + '-msg-bubble');
      var fullText = '';
      var displayedLen = 0;
      var renderTimer = null;
      var hasFilter = typeof config.filterDisplay === 'function';

      function startTypewriter() {
        if (renderTimer) return;
        renderTimer = setInterval(function() {
          if (displayedLen < fullText.length) {
            var backlog = fullText.length - displayedLen;
            var step = backlog > 200 ? 8 : backlog > 80 ? 5 : backlog > 30 ? 3 : backlog > 10 ? 2 : 1;
            displayedLen += step;
            if (displayedLen > fullText.length) displayedLen = fullText.length;
            var displayText = fullText.substring(0, displayedLen);
            if (hasFilter) displayText = config.filterDisplay(displayText);
            bubble.innerHTML = formatContent(displayText);
          } else {
            clearInterval(renderTimer);
            renderTimer = null;
          }
        }, 16);
      }

      try {
        var context = {};
        if (typeof config.buildContext === 'function') {
          context = config.buildContext(messages);
        }

        // Auth ride-along is now handled by the HttpOnly page-token cookie set
        // during /api/page-token/request (see shared/page-token.js). Wait for
        // that initial mint to complete before the first chat request so the
        // server side of the verify has a cookie to read.
        if (window.mrPageToken && window.mrPageToken.ready) {
          try { await window.mrPageToken.ready(); } catch (_) { /* server will 403 */ }
        }
        var resp = await fetch(config.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            messages: messages,
            context: context
          })
        });

        if (!resp.ok) {
          bubble.textContent = 'Sorry, I had trouble connecting. Please try again.';
          aiDiv.classList.remove('streaming');
          isStreaming = false;
          document.getElementById(ids.send).disabled = false;
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
                } else if (parsed.type === 'error') {
                  fullText = 'Sorry, I had trouble connecting. Please try again in a moment.';
                  break;
                } else if (parsed.type === 'message_stop') {
                  break;
                }
              } catch(e) {}
            }
          }
        }

        // If onStreamComplete needs to wait for typewriter, do so
        if (typeof config.onStreamComplete === 'function') {
          // Wait for typewriter to finish
          await new Promise(function(resolve) {
            var wait = setInterval(function() {
              if (displayedLen >= fullText.length || !renderTimer) {
                clearInterval(wait);
                resolve();
              }
            }, 50);
          });
        }

        if (renderTimer) clearInterval(renderTimer);
        if (!fullText) fullText = 'Sorry, I was unable to generate a response. Please try again.';

        // Final render — apply filter if present
        var finalDisplay = fullText;
        if (hasFilter) finalDisplay = config.filterDisplay(finalDisplay);
        bubble.innerHTML = formatContent(finalDisplay);
      } catch(e) {
        if (!fullText) bubble.textContent = 'Sorry, something went wrong. Please try again.';
      }

      aiDiv.classList.remove('streaming');

      // Let onStreamComplete run before pushing to messages (it may clean fullText)
      if (typeof config.onStreamComplete === 'function') {
        config.onStreamComplete(fullText, aiDiv, {
          messages: messages,
          addMessage: addMessage,
          formatContent: formatContent,
          panel: panel,
          ids: ids
        });
      } else {
        messages.push({ role: 'assistant', content: fullText });
      }

      isStreaming = false;
      document.getElementById(ids.send).disabled = false;
      container.scrollTop = container.scrollHeight;
    }

    // ============================================================
    // Return public API
    // ============================================================
    return {
      addMessage: addMessage,
      panel: panel,
      messages: messages,
      tooltip: tooltip,
      btn: btn
    };
  };

  // ==============================================================
  // CSS BUILDER — parameterized by prefix
  // ==============================================================
  function buildCSS(p, chipStyle, chipClass) {
    var vertical = chipStyle === 'vertical';
    // Chip container and chip styles differ for vertical vs horizontal
    var chipContainerCSS = '';
    var chipCSS = '';

    if (vertical) {
      chipContainerCSS = '.' + p + '-suggestions { display: flex; flex-direction: column; gap: .35rem; margin-top: .75rem; width: 100%; }';
      chipCSS = '.' + chipClass + ' {\n' +
        '  padding: .5rem .75rem; border-radius: 8px; font-size: .78rem; text-align: left;\n' +
        '  border: 1px solid var(--color-border, #E2E8F0); background: transparent;\n' +
        '  color: var(--color-body, #333F70); cursor: pointer; font-family: inherit;\n' +
        '  transition: all .15s;\n' +
        '}\n' +
        '.' + chipClass + ':hover { border-color: var(--color-primary, #00D47E); background: rgba(0,212,126,.04); }';
    } else {
      chipContainerCSS = '.' + p + '-welcome-chips { display: flex; flex-wrap: wrap; gap: .35rem; justify-content: center; margin-top: .5rem; }';
      chipCSS = '.' + chipClass + ' {\n' +
        '  padding: .35rem .65rem; border-radius: 8px; font-size: .75rem;\n' +
        '  border: 1px solid var(--color-border, #E2E8F0); background: var(--color-surface, #fff);\n' +
        '  color: var(--color-body, #333F70); cursor: pointer; transition: all .15s;\n' +
        '  font-family: inherit;\n' +
        '}\n' +
        '.' + chipClass + ':hover { border-color: var(--color-primary, #00D47E); color: var(--color-primary, #00D47E); background: var(--color-primary-subtle, #DDF8F2); }';
    }

    return `
    .${p}-btn {
      position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999;
      width: 52px; height: 52px; border-radius: 50%;
      background: var(--color-primary, #00D47E); border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,212,126,.35);
      display: flex; align-items: center; justify-content: center;
      transition: transform .15s, box-shadow .15s;
    }
    .${p}-btn:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(0,212,126,.45); }
    .${p}-btn svg { width: 24px; height: 24px; fill: #fff; }

    .${p}-tooltip {
      position: fixed; bottom: 6.5rem; right: 1.5rem; z-index: 9998;
      background: var(--color-surface, #fff); border: 1px solid var(--color-border, #E2E8F0);
      border-radius: 12px; padding: .85rem 1rem; max-width: 280px;
      box-shadow: 0 8px 32px rgba(0,0,0,.1);
      animation: ${p}FadeIn .4s ease;
      font-family: 'Inter', -apple-system, sans-serif;
    }
    .${p}-tooltip::after {
      content: ''; position: absolute; bottom: -8px; right: 24px;
      width: 16px; height: 16px; background: var(--color-surface, #fff);
      border-right: 1px solid var(--color-border, #E2E8F0);
      border-bottom: 1px solid var(--color-border, #E2E8F0);
      transform: rotate(45deg);
    }
    .${p}-tooltip-header { display: flex; align-items: flex-start; gap: .5rem; }
    .${p}-tooltip-icon { font-size: 1.25rem; flex-shrink: 0; line-height: 1; }
    .${p}-tooltip-text { font-size: .82rem; color: var(--color-body, #333F70); line-height: 1.5; flex: 1; }
    .${p}-tooltip-text strong { color: var(--color-heading, #1E2A5E); font-weight: 600; }
    .${p}-tooltip-close {
      position: absolute; top: .5rem; right: .5rem;
      background: none; border: none; cursor: pointer;
      color: var(--color-muted, #6B7599); font-size: 1rem; line-height: 1; padding: .15rem;
    }
    .${p}-tooltip-close:hover { color: var(--color-heading, #1E2A5E); }
    .${p}-tooltip.hidden { display: none; }

    .${p}-panel {
      position: fixed; bottom: 5rem; right: 1.5rem; z-index: 9998;
      width: 400px; height: 520px; max-height: calc(100vh - 7rem);
      background: var(--color-surface, #fff);
      border: 1px solid var(--color-border, #E2E8F0);
      border-radius: 16px;
      box-shadow: 0 12px 48px rgba(0,0,0,.12);
      display: none; flex-direction: column;
      animation: ${p}SlideUp .25s ease;
      font-family: 'Inter', -apple-system, sans-serif;
      overflow: hidden;
    }
    .${p}-panel.open { display: flex; }

    .${p}-header {
      padding: .75rem 1rem; display: flex; align-items: center; gap: .6rem;
      border-bottom: 1px solid var(--color-border, #E2E8F0); flex-shrink: 0;
    }
    .${p}-header-icon {
      width: 32px; height: 32px; border-radius: 8px;
      background: var(--color-primary-subtle, #DDF8F2);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .${p}-header-icon img { width: 20px; height: 20px; object-fit: contain; }
    .${p}-header-info { flex: 1; }
    .${p}-header-title {
      font-family: 'Outfit', sans-serif; font-weight: 600;
      font-size: .88rem; color: var(--color-heading, #1E2A5E);
    }
    .${p}-header-sub { font-size: .68rem; color: var(--color-muted, #6B7599); }
    .${p}-close {
      width: 32px; height: 32px; border-radius: 8px;
      border: none; cursor: pointer; background: none;
      color: var(--color-muted, #6B7599); font-size: 1.1rem;
      display: flex; align-items: center; justify-content: center;
    }
    .${p}-close:hover { background: var(--color-bg, #F7FDFB); color: var(--color-heading, #1E2A5E); }

    .${p}-messages {
      flex: 1; overflow-y: auto; padding: 1rem;
      display: flex; flex-direction: column; gap: .65rem;
    }

    .${p}-msg { display: flex; max-width: 88%; animation: ${p}FadeIn .2s ease; }
    .${p}-msg-user { align-self: flex-end; }
    .${p}-msg-ai { align-self: flex-start; }

    .${p}-msg-bubble {
      padding: .55rem .8rem; border-radius: 12px;
      font-size: .84rem; line-height: 1.6;
      color: var(--color-body, #333F70);
    }
    .${p}-msg-ai .${p}-msg-bubble { background: var(--color-bg, #F7FDFB); border: 1px solid var(--color-border, #E2E8F0); }
    .${p}-msg-user .${p}-msg-bubble { background: var(--color-primary, #00D47E); color: #0a1e14; border-radius: 12px 12px 4px 12px; }
    .${p}-msg-bubble p { margin: 0 0 .4rem; }
    .${p}-msg-bubble p:last-child { margin-bottom: 0; }
    .${p}-msg-bubble a { color: var(--color-primary, #00D47E); text-decoration: underline; }

    .${p}-msg-ai.streaming .${p}-msg-bubble::after {
      content: ''; display: inline-block; width: 6px; height: 14px;
      background: var(--color-primary, #00D47E); border-radius: 1px;
      animation: ${p}Blink .6s step-end infinite; margin-left: 2px; vertical-align: text-bottom;
    }

    .${p}-welcome {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 1.5rem; text-align: center; gap: .75rem;
    }
    .${p}-welcome-icon { font-size: 2rem; }
    .${p}-welcome h3 {
      font-family: 'Outfit', sans-serif; font-size: 1rem;
      font-weight: 600; color: var(--color-heading, #1E2A5E); margin: 0;
    }
    .${p}-welcome p { font-size: .82rem; color: var(--color-muted, #6B7599); margin: 0; line-height: 1.5; }
    ${chipContainerCSS}
    ${chipCSS}

    .${p}-input-area {
      padding: .65rem .75rem; border-top: 1px solid var(--color-border, #E2E8F0); flex-shrink: 0;
    }
    .${p}-input-wrap { display: flex; gap: .35rem; align-items: flex-end; }
    .${p}-input {
      flex: 1; padding: .5rem .65rem; border-radius: 10px;
      border: 1px solid var(--color-border, #E2E8F0);
      background: var(--color-bg, #F7FDFB);
      color: var(--color-body, #333F70);
      font-family: 'Inter', sans-serif; font-size: .84rem;
      resize: none; outline: none; max-height: 100px; min-height: 36px; line-height: 1.4;
    }
    .${p}-input:focus { border-color: var(--color-primary, #00D47E); }
    .${p}-input::placeholder { color: var(--color-muted, #6B7599); }
    .${p}-send {
      width: 36px; height: 36px; border-radius: 8px;
      background: var(--color-primary, #00D47E); border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      transition: opacity .1s;
    }
    .${p}-send:disabled { opacity: .4; cursor: not-allowed; }
    .${p}-send svg { width: 16px; height: 16px; fill: #0a1e14; }

    @keyframes ${p}FadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes ${p}SlideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes ${p}Blink { 50% { opacity: 0; } }

    @media (max-width: 480px) {
      .${p}-panel { width: calc(100vw - 1.5rem); right: .75rem; bottom: 4.5rem; height: calc(100vh - 6rem); }
      .${p}-btn { bottom: 1rem; right: 1rem; width: 46px; height: 46px; }
      .${p}-tooltip { right: 1rem; bottom: 4.5rem; max-width: calc(100vw - 2rem); }
    }

    @media print { .${p}-btn, .${p}-panel, .${p}-tooltip { display: none !important; } }
    `;
  }

  // ==============================================================
  // HELPERS
  // ==============================================================
  function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escAttr(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

})();
