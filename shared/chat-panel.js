// /shared/chat-panel.js - COREBot Chat Panel
// Self-contained component: injects CSS, creates UI, handles streaming chat
// Include via <script src="/shared/chat-panel.js"></script> on any admin page

(function() {
  'use strict';

  // ============================================================
  // CONFIG
  // ============================================================
  var CHAT_API = '/api/chat';
  var ACTION_API = '/api/action';
  var SESSION_KEY = 'moonraker-chat-history';
  var OPEN_KEY = 'moonraker-chat-open';

  // ============================================================
  // INJECT CSS
  // ============================================================
  var style = document.createElement('style');
  style.textContent = `
    /* Chat Panel */
    .mr-chat-btn {
      position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999;
      width: 52px; height: 52px; border-radius: 50%;
      background: var(--color-primary, #00D47E); border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,212,126,.35);
      display: flex; align-items: center; justify-content: center;
      transition: transform .15s, box-shadow .15s;
    }
    .mr-chat-btn:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(0,212,126,.45); }
    .mr-chat-btn svg { width: 24px; height: 24px; fill: #fff; }
    .mr-chat-btn .badge {
      position: absolute; top: -2px; right: -2px;
      width: 14px; height: 14px; border-radius: 50%;
      background: var(--color-warning, #F59E0B);
      border: 2px solid var(--color-bg, #080F0B);
      display: none;
    }

    .mr-chat-panel {
      position: fixed; top: 0; bottom: 0; right: -440px; z-index: 9998;
      width: 420px;
      background: var(--color-surface, #0E1A14);
      border-left: 1px solid var(--color-border, #1E3530);
      display: flex; flex-direction: column;
      transition: right .25s cubic-bezier(.4,0,.2,1);
      box-shadow: -8px 0 32px rgba(0,0,0,.2);
    }
    .mr-chat-panel.open { right: 0; }

    .mr-chat-header {
      padding: .75rem 1rem; display: flex; align-items: center; gap: .65rem;
      border-bottom: 1px solid var(--color-border, #1E3530);
      flex-shrink: 0;
    }
    .mr-chat-header-icon {
      width: 32px; height: 32px; border-radius: 8px;
      background: var(--color-primary-subtle, #0D2E22);
      display: flex; align-items: center; justify-content: center;
    }
    .mr-chat-header-icon img { width: 22px; height: 22px; object-fit: contain; }
    .mr-chat-header-info { flex: 1; min-width: 0; }
    .mr-chat-header-title {
      font-family: 'Outfit', sans-serif; font-weight: 600;
      font-size: .9rem; color: var(--color-heading, #E8F5EF);
    }
    .mr-chat-header-sub {
      font-size: .7rem; color: var(--color-muted, #5A7A6E);
      font-weight: 400;
    }
    .mr-chat-header-actions { display: flex; align-items: center; gap: .35rem; flex-shrink: 0; }
    .mr-chat-clear {
      width: 36px; height: 36px; border-radius: 8px;
      border: none; cursor: pointer;
      background: var(--color-bg, #080F0B); color: var(--color-muted, #5A7A6E);
      display: flex; align-items: center; justify-content: center;
      font-size: 1rem; font-weight: 600; transition: background .1s, color .1s;
    }
    .mr-chat-clear:hover {
      background: var(--color-warning, #F59E0B);
      color: #fff;
    }
    .mr-chat-close {
      width: 36px; height: 36px; border-radius: 8px;
      border: none; cursor: pointer;
      background: var(--color-bg, #080F0B); color: var(--color-muted, #5A7A6E);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.2rem; font-weight: 600; transition: background .1s, color .1s;
    }
    .mr-chat-close:hover {
      background: var(--color-danger, #EF4444);
      color: #fff;
    }

    .mr-chat-messages {
      flex: 1; overflow-y: auto; padding: 1rem;
      display: flex; flex-direction: column; gap: .75rem;
    }
    .mr-chat-messages::-webkit-scrollbar { width: 4px; }
    .mr-chat-messages::-webkit-scrollbar-thumb { background: var(--color-border, #1E3530); border-radius: 2px; }

    .mr-msg {
      max-width: 92%; padding: .65rem .85rem;
      border-radius: 12px; font-size: .84rem; line-height: 1.55;
      word-wrap: break-word; white-space: pre-wrap;
    }
    .mr-msg a { color: var(--color-primary, #00D47E); text-decoration: underline; }
    .mr-msg code {
      background: var(--color-bg, #080F0B); padding: .1rem .35rem;
      border-radius: 4px; font-size: .78rem;
    }
    .mr-msg pre {
      background: var(--color-bg, #080F0B); padding: .6rem .75rem;
      border-radius: 6px; overflow-x: auto; margin: .4rem 0;
      border: 1px solid var(--color-border, #1E3530);
    }
    .mr-msg pre code { background: none; padding: 0; font-size: .76rem; }
    .mr-msg h1, .mr-msg h2, .mr-msg h3 {
      font-family: 'Outfit', sans-serif; color: var(--color-heading, #E8F5EF);
      margin: .6rem 0 .3rem; line-height: 1.3;
    }
    .mr-msg h1 { font-size: 1.05rem; font-weight: 700; }
    .mr-msg h2 { font-size: .95rem; font-weight: 600; }
    .mr-msg h3 { font-size: .88rem; font-weight: 600; }
    .mr-msg ul, .mr-msg ol { margin: .3rem 0 .3rem 1.2rem; padding: 0; }
    .mr-msg li { margin: .15rem 0; }
    .mr-msg hr {
      border: none; border-top: 1px solid var(--color-border, #1E3530);
      margin: .6rem 0;
    }
    .mr-msg blockquote {
      border-left: 3px solid var(--color-primary, #00D47E);
      padding: .3rem .6rem; margin: .4rem 0;
      color: var(--color-muted, #5A7A6E);
    }
    .mr-msg table {
      border-collapse: collapse; width: 100%; margin: .4rem 0; font-size: .78rem;
    }
    .mr-msg th, .mr-msg td {
      border: 1px solid var(--color-border, #1E3530);
      padding: .3rem .5rem; text-align: left;
    }
    .mr-msg th {
      background: var(--color-bg, #080F0B);
      font-weight: 600; color: var(--color-heading, #E8F5EF);
    }
    .mr-msg-user {
      align-self: flex-end;
      background: var(--color-primary, #00D47E); color: #0a1e14;
      border-bottom-right-radius: 4px;
    }
    .mr-msg-ai {
      align-self: flex-start;
      background: var(--color-bg, #080F0B);
      color: var(--color-body, #C8D8D0);
      border-bottom-left-radius: 4px;
      border: 1px solid var(--color-border, #1E3530);
    }
    .mr-msg-ai .mr-msg-label {
      font-size: .65rem; font-weight: 600; color: var(--color-primary, #00D47E);
      margin-bottom: .25rem; text-transform: uppercase; letter-spacing: .04em;
    }
    .mr-msg-system {
      align-self: center; text-align: center;
      color: var(--color-muted, #5A7A6E);
      font-size: .75rem; padding: .25rem .5rem;
      background: none; border: none;
    }

    /* Streaming indicator */
    .mr-msg-ai.streaming { transition: none; }
    .mr-msg-ai.streaming .mr-msg-content { transition: none; }
    .mr-msg-ai.streaming::after {
      content: ''; display: inline-block;
      width: 6px; height: 14px; margin-left: 2px;
      background: var(--color-primary, #00D47E);
      animation: mr-blink .6s infinite;
    }
    @keyframes mr-blink { 0%,100%{opacity:1} 50%{opacity:0} }

    /* Action cards */
    .mr-action-card {
      margin: .5rem 0; padding: .65rem .85rem;
      border-radius: 8px;
      border: 1px solid var(--color-primary, #00D47E);
      background: var(--color-primary-subtle, #0D2E22);
    }
    .mr-action-card-header {
      font-size: .72rem; font-weight: 600;
      color: var(--color-primary, #00D47E);
      text-transform: uppercase; letter-spacing: .04em;
      margin-bottom: .35rem;
    }
    .mr-action-card-body {
      font-size: .78rem; color: var(--color-body, #C8D8D0);
      line-height: 1.5; margin-bottom: .5rem;
    }
    .mr-action-card-body strong { color: var(--color-heading, #E8F5EF); }
    .mr-action-card-actions {
      display: flex; gap: .4rem;
    }
    .mr-action-btn {
      padding: .3rem .7rem; border-radius: 6px;
      font-size: .75rem; font-weight: 500;
      border: none; cursor: pointer; font-family: inherit;
      transition: opacity .1s;
    }
    .mr-action-btn:hover { opacity: .85; }
    .mr-action-btn-confirm {
      background: var(--color-primary, #00D47E); color: #0a1e14;
    }
    .mr-action-btn-cancel {
      background: var(--color-border, #1E3530);
      color: var(--color-body, #C8D8D0);
    }
    .mr-action-card.executed {
      border-color: var(--color-muted, #5A7A6E);
      opacity: .6;
    }
    .mr-action-card.executed .mr-action-card-actions { display: none; }
    .mr-action-card.executed::after {
      content: 'Executed'; display: block;
      font-size: .7rem; color: var(--color-success, #00D47E);
      font-weight: 500; margin-top: .25rem;
    }

    /* Input area */
    .mr-chat-input-area {
      padding: .65rem; border-top: 1px solid var(--color-border, #1E3530);
      flex-shrink: 0;
    }
    .mr-chat-input-wrap {
      display: flex; gap: .4rem; align-items: flex-end;
    }
    .mr-chat-input {
      flex: 1; padding: .55rem .75rem;
      border-radius: 10px; border: 1px solid var(--color-border, #1E3530);
      background: var(--color-bg, #080F0B);
      color: var(--color-body, #C8D8D0);
      font-family: 'Inter', sans-serif; font-size: .84rem;
      resize: none; outline: none;
      max-height: 120px; min-height: 38px;
      line-height: 1.4;
      transition: border-color .15s;
    }
    .mr-chat-input:focus { border-color: var(--color-primary, #00D47E); }
    .mr-chat-input::placeholder { color: var(--color-muted, #5A7A6E); }
    .mr-chat-send {
      width: 36px; height: 36px; border-radius: 8px;
      background: var(--color-primary, #00D47E); border: none;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: opacity .1s;
    }
    .mr-chat-send:disabled { opacity: .4; cursor: not-allowed; }
    .mr-chat-send svg { width: 16px; height: 16px; fill: #0a1e14; }

    .mr-chat-context {
      padding: .35rem .75rem; font-size: .68rem;
      color: var(--color-muted, #5A7A6E);
      display: flex; align-items: center; gap: .35rem;
    }
    .mr-chat-context-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--color-primary, #00D47E);
    }

    /* Welcome state */
    .mr-chat-welcome {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 2rem; text-align: center; gap: 1rem;
    }
    .mr-chat-welcome-icon {
      width: 48px; height: 48px; border-radius: 12px;
      background: var(--color-primary-subtle, #0D2E22);
      display: flex; align-items: center; justify-content: center;
    }
    .mr-chat-welcome-icon img { width: 32px; height: 32px; object-fit: contain; }
    .mr-chat-welcome h3 {
      font-family: 'Outfit', sans-serif; font-size: 1rem;
      color: var(--color-heading, #E8F5EF); margin: 0;
    }
    .mr-chat-welcome p {
      font-size: .82rem; color: var(--color-muted, #5A7A6E);
      line-height: 1.5; max-width: 280px;
    }
    .mr-chat-suggestions {
      display: flex; flex-direction: column; gap: .35rem; width: 100%;
    }
    .mr-chat-suggestion {
      padding: .5rem .75rem; border-radius: 8px;
      border: 1px solid var(--color-border, #1E3530);
      background: var(--color-bg, #080F0B);
      color: var(--color-body, #C8D8D0);
      font-size: .78rem; cursor: pointer;
      text-align: left; font-family: inherit;
      transition: border-color .15s, background .15s;
    }
    .mr-chat-suggestion:hover {
      border-color: var(--color-primary, #00D47E);
      background: var(--color-primary-subtle, #0D2E22);
    }

    /* Mobile */
    @media (max-width: 768px) {
      .mr-chat-panel { width: 100vw; right: -100vw; }
      .mr-chat-btn { bottom: 1rem; right: 1rem; width: 46px; height: 46px; }
    }

    /* Button hidden via JS when panel is open */
    .mr-chat-btn.hidden { display: none !important; }
  `;
  document.head.appendChild(style);

  // ============================================================
  // STATE
  // ============================================================
  var messages = [];
  var isStreaming = false;
  var panelOpen = false;
  var currentStreamEl = null;
  var currentStreamText = '';

  // Restore history from session
  try {
    var saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) messages = JSON.parse(saved);
  } catch(e) {}

  // ============================================================
  // BUILD UI
  // ============================================================

  // Floating button
  var btn = document.createElement('button');
  btn.className = 'mr-chat-btn';
  btn.title = 'Open AI Assistant';
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg><span class="badge"></span>';
  btn.onclick = function() { togglePanel(true); };
  document.body.appendChild(btn);

  // Panel
  var panel = document.createElement('div');
  panel.className = 'mr-chat-panel';
  panel.innerHTML = `
    <div class="mr-chat-header">
      <div class="mr-chat-header-icon">
        <img src="/assets/logo.png" alt="Moonraker">
      </div>
      <div class="mr-chat-header-info">
        <div class="mr-chat-header-title">COREBot</div>
        <div class="mr-chat-header-sub">Claude Sonnet 4.6</div>
      </div>
      <div class="mr-chat-header-actions">
        <button class="mr-chat-clear" title="Clear history" id="mrChatClear">&#8635;</button>
        <button class="mr-chat-close" title="Close" id="mrChatClose">&times;</button>
      </div>
    </div>
    <div class="mr-chat-messages" id="mrChatMessages"></div>
    <div class="mr-chat-input-area">
      <div class="mr-chat-context" id="mrChatContext"></div>
      <div class="mr-chat-input-wrap">
        <textarea class="mr-chat-input" id="mrChatInput" placeholder="Ask anything or request an action..." rows="1"></textarea>
        <button class="mr-chat-send" id="mrChatSend" title="Send"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  var messagesEl = document.getElementById('mrChatMessages');
  var inputEl = document.getElementById('mrChatInput');
  var sendBtn = document.getElementById('mrChatSend');

  document.getElementById('mrChatClose').onclick = function() { togglePanel(false); };
  document.getElementById('mrChatClear').onclick = clearHistory;
  sendBtn.onclick = sendMessage;

  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  inputEl.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // ============================================================
  // CONTEXT DETECTION
  // ============================================================
  function getPageContext() {
    var path = window.location.pathname;
    var params = new URLSearchParams(window.location.search);
    var slug = params.get('slug');

    var ctx = { page: path };

    if (slug) ctx.clientSlug = slug;

    // Detect active tab
    var activeTab = document.querySelector('.tab-btn.active');
    if (activeTab) ctx.tab = activeTab.dataset.tab || activeTab.textContent.trim();

    // Try to get client data from the page's state if available
    if (typeof window._mrChatContext === 'object') {
      Object.assign(ctx, window._mrChatContext);
    }

    // Include lightweight client index for cross-client operations
    if (clientIndex) {
      ctx.clientIndex = clientIndex.map(function(c) {
        return { slug: c.slug, name: c.practice_name, status: c.status, lost: c.lost, id: c.id };
      });
    }

    return ctx;
  }

  function updateContextDisplay() {
    var ctx = getPageContext();
    var parts = [];
    if (ctx.clientSlug) parts.push(ctx.clientSlug);
    if (ctx.tab) parts.push(ctx.tab);
    if (parts.length === 0) parts.push(ctx.page);

    var el = document.getElementById('mrChatContext');
    el.innerHTML = '<span class="mr-chat-context-dot"></span> Context: ' + esc(parts.join(' / '));
  }

  // ============================================================
  // PANEL TOGGLE
  // ============================================================
  function togglePanel(open) {
    panelOpen = open;
    if (open) {
      panel.classList.add('open');
      btn.classList.add('hidden');
      updateContextDisplay();
      renderMessages();
      setTimeout(function() { inputEl.focus(); }, 300);
    } else {
      panel.classList.remove('open');
      setTimeout(function() { btn.classList.remove('hidden'); }, 250);
    }
    try { sessionStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch(e) {}
  }

  // Restore open state
  try { if (sessionStorage.getItem(OPEN_KEY) === '1') togglePanel(true); } catch(e) {}

  // ============================================================
  // MESSAGE RENDERING
  // ============================================================
  function renderMessages() {
    if (messages.length === 0) {
      renderWelcome();
      return;
    }

    var html = '';
    messages.forEach(function(msg, idx) {
      if (msg.hidden) return; // Skip auto-fetch data messages
      if (msg.role === 'user') {
        html += '<div class="mr-msg mr-msg-user">' + esc(msg.content) + '</div>';
      } else if (msg.role === 'assistant') {
        html += '<div class="mr-msg mr-msg-ai"><div class="mr-msg-label">COREBot</div>' + formatAIMessage(msg.content, idx) + '</div>';
      } else if (msg.role === 'system') {
        html += '<div class="mr-msg mr-msg-system">' + esc(msg.content) + '</div>';
      }
    });

    messagesEl.innerHTML = html;
    scrollToBottom();
    bindActionButtons();
  }

  function renderWelcome() {
    var ctx = getPageContext();
    var suggestions = getSuggestions(ctx);

    var html = '<div class="mr-chat-welcome">';
    html += '<div class="mr-chat-welcome-icon"><img src="/assets/logo.png" alt="Moonraker"></div>';
    html += '<h3>COREBot</h3>';
    html += '<p>I can help you manage clients, update deliverables, build audits, and more. What would you like to do?</p>';
    html += '<div class="mr-chat-suggestions">';
    suggestions.forEach(function(s) {
      html += '<button class="mr-chat-suggestion" data-msg="' + esc(s) + '">' + esc(s) + '</button>';
    });
    html += '</div></div>';

    messagesEl.innerHTML = html;

    // Bind suggestion clicks
    messagesEl.querySelectorAll('.mr-chat-suggestion').forEach(function(btn) {
      btn.onclick = function() {
        inputEl.value = this.dataset.msg;
        sendMessage();
      };
    });
  }

  function getSuggestions(ctx) {
    if (ctx.clientSlug) {
      return [
        'What are the highest priority items for this client?',
        'Show me a summary of campaign progress',
        'What deliverables are still pending?',
        'Update the campaign notes'
      ];
    }
    if (ctx.page && ctx.page.includes('/admin/deliverables')) {
      return [
        'Which clients have the most overdue deliverables?',
        'Show me all Phase 1 items that are not started',
        'What should the team focus on today?'
      ];
    }
    if (ctx.page && ctx.page.includes('/admin/reports')) {
      return [
        'Which clients need reports this month?',
        'Create a report config for a new client',
        'What data sources are configured?'
      ];
    }
    return [
      'Show me a summary of all active clients',
      'Which clients have incomplete onboarding?',
      'What are the highest priority tasks across all clients?',
      'Help me create a new client record'
    ];
  }

  function formatAIMessage(text, msgIdx) {
    // During streaming, hide any trailing unclosed action block (partial JSON would leak as text)
    var lastOpen = text.lastIndexOf('```action');
    if (lastOpen !== -1) {
      var afterOpen = text.substring(lastOpen);
      if (!afterOpen.match(/```action\n?[\s\S]*?```/)) {
        text = text.substring(0, lastOpen);
      }
    }

    // Parse action blocks and format the rest as basic markdown
    var parts = text.split(/```action\n?([\s\S]*?)```/g);
    var html = '';

    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        // Regular text - apply basic formatting
        html += formatMarkdown(parts[i]);
      } else {
        // Action block
        try {
          var actionData = JSON.parse(parts[i].trim());
          html += renderActionCard(actionData, msgIdx + '-' + Math.floor(i/2));
        } catch(e) {
          html += '<code>' + esc(parts[i]) + '</code>';
        }
      }
    }
    return html;
  }

  function formatMarkdown(text) {
    if (!text) return '';

    // Extract code blocks first to protect them
    var codeBlocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function(m, lang, code) {
      codeBlocks.push('<pre><code>' + esc(code.trim()) + '</code></pre>');
      return '\x00CB' + (codeBlocks.length - 1) + '\x00';
    });

    // Split into lines for block-level processing
    var lines = text.split('\n');
    var html = '';
    var inList = false;
    var listType = '';
    var inTable = false;
    var tableRows = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Code block placeholder
      var cbMatch = line.match(/\x00CB(\d+)\x00/);
      if (cbMatch) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        if (inTable) { html += renderTable(tableRows); inTable = false; tableRows = []; }
        html += codeBlocks[parseInt(cbMatch[1])];
        continue;
      }

      // Horizontal rule
      if (/^---+$/.test(line.trim())) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        if (inTable) { html += renderTable(tableRows); inTable = false; tableRows = []; }
        html += '<hr>';
        continue;
      }

      // Headers
      var hMatch = line.match(/^(#{1,3})\s+(.+)/);
      if (hMatch) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        if (inTable) { html += renderTable(tableRows); inTable = false; tableRows = []; }
        var level = hMatch[1].length;
        html += '<h' + level + '>' + inlineFmt(hMatch[2]) + '</h' + level + '>';
        continue;
      }

      // Table row
      if (line.trim().indexOf('|') === 0 && line.trim().lastIndexOf('|') === line.trim().length - 1) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        // Skip separator rows
        if (/^\|[\s\-:|]+\|$/.test(line.trim())) { continue; }
        inTable = true;
        tableRows.push(line.trim());
        continue;
      } else if (inTable) {
        html += renderTable(tableRows);
        inTable = false;
        tableRows = [];
      }

      // Blockquote
      if (line.match(/^>\s?(.*)$/)) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        html += '<blockquote>' + inlineFmt(line.replace(/^>\s?/, '')) + '</blockquote>';
        continue;
      }

      // Unordered list
      if (line.match(/^\s*[-*]\s+/)) {
        if (!inList || listType !== 'ul') {
          if (inList) html += '</' + listType + '>';
          html += '<ul>';
          inList = true;
          listType = 'ul';
        }
        html += '<li>' + inlineFmt(line.replace(/^\s*[-*]\s+/, '')) + '</li>';
        continue;
      }

      // Ordered list
      if (line.match(/^\s*\d+\.\s+/)) {
        if (!inList || listType !== 'ol') {
          if (inList) html += '</' + listType + '>';
          html += '<ol>';
          inList = true;
          listType = 'ol';
        }
        html += '<li>' + inlineFmt(line.replace(/^\s*\d+\.\s+/, '')) + '</li>';
        continue;
      }

      // Close list if we hit a non-list line
      if (inList) {
        html += '</' + listType + '>';
        inList = false;
      }

      // Empty line = paragraph break
      if (line.trim() === '') {
        html += '<br>';
        continue;
      }

      // Regular text
      html += inlineFmt(line) + '<br>';
    }

    if (inList) html += '</' + listType + '>';
    if (inTable) html += renderTable(tableRows);

    // Clean up double breaks
    html = html.replace(/<br><br><br>/g, '<br><br>');

    return html;
  }

  function inlineFmt(text) {
    var h = esc(text);
    h = h.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\*(.*?)\*/g, '<em>$1</em>');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(m, label, url) {
      try {
        var u = new URL(url, location.href);
        if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') return label;
      } catch(_) { return label; }
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    return h;
  }

  function renderTable(rows) {
    if (rows.length === 0) return '';
    var html = '<table>';
    rows.forEach(function(row, idx) {
      var cells = row.split('|').filter(function(c) { return c.trim() !== ''; });
      var tag = idx === 0 ? 'th' : 'td';
      html += '<tr>';
      cells.forEach(function(cell) {
        html += '<' + tag + '>' + inlineFmt(cell.trim()) + '</' + tag + '>';
      });
      html += '</tr>';
    });
    html += '</table>';
    return html;
  }

  function renderActionCard(actionData, cardId) {
    var action = actionData.action || 'unknown';
    var table = actionData.table || '';
    var data = actionData.data || {};
    var filters = actionData.filters || {};

    // Auto-execute read actions - each cardId fires at most once ever
    if (action === 'read_records') {
      if (isAutoReadFollowUp || executedReadIds[cardId]) {
        return '';
      }

      // Suppress reads for tables already in the client deep-dive context
      var ctx = window._mrChatContext;
      if (ctx && ctx.clientSlug && ctx.clientData) {
        var alreadyLoaded = ['contacts', 'onboarding_steps', 'intro_call_steps', 'checklist_items',
          'deliverables', 'entity_audits', 'report_snapshots', 'practice_details', 'proposals'];
        if (alreadyLoaded.indexOf(table) !== -1) {
          executedReadIds[cardId] = true;
          suppressedReadCount++;
          return ''; // Data already in context, no fetch needed
        }
      }

      executedReadIds[cardId] = true;
      setTimeout(function() { autoExecuteRead(actionData, cardId); }, 100);
      return '<div class="mr-action-card" data-card-id="' + cardId + '" id="read-card-' + cardId + '">' +
        '<div class="mr-action-card-header">&#128269; READING ' + esc(table).toUpperCase() + '</div>' +
        '<div class="mr-action-card-body" style="color:var(--color-muted);">Loading data...</div>' +
        '</div>';
    }

    var label = action.replace(/_/g, ' ').toUpperCase();
    var desc = '';

    if (action === 'update_record' || action === 'bulk_update') {
      var fields = Object.keys(data).map(function(k) {
        return '<strong>' + esc(k) + '</strong>: ' + esc(String(data[k]));
      }).join(', ');
      var where = Object.keys(filters).map(function(k) {
        return k + '=' + filters[k];
      }).join(', ');
      desc = 'Set ' + fields + ' on <strong>' + esc(table) + '</strong> where ' + where;
    } else if (action === 'create_record') {
      var mainField = data.title || data.practice_name || data.first_name || data.step_key || '';
      desc = 'Create new <strong>' + esc(table) + '</strong> record' + (mainField ? ': ' + esc(String(mainField)) : '');
    } else if (action === 'delete_record') {
      desc = 'Delete from <strong>' + esc(table) + '</strong> where id=' + esc(String(filters.id || '?'));
    }

    var html = '<div class="mr-action-card" data-card-id="' + cardId + '" data-action=\'' + esc(JSON.stringify(actionData)) + '\'>';
    html += '<div class="mr-action-card-header">&#9889; ' + label + '</div>';
    html += '<div class="mr-action-card-body">' + desc + '</div>';
    html += '<div class="mr-action-card-actions">';
    html += '<button class="mr-action-btn mr-action-btn-confirm" data-card="' + cardId + '">Confirm</button>';
    html += '<button class="mr-action-btn mr-action-btn-cancel" data-card="' + cardId + '">Skip</button>';
    html += '</div></div>';

    return html;
  }

  function bindActionButtons() {
    messagesEl.querySelectorAll('.mr-action-btn-confirm').forEach(function(btn) {
      btn.onclick = function() { executeAction(this.dataset.card); };
    });
    messagesEl.querySelectorAll('.mr-action-btn-cancel').forEach(function(btn) {
      btn.onclick = function() { skipAction(this.dataset.card); };
    });
  }

  // ============================================================
  // ACTION EXECUTION
  // ============================================================
  var pendingReads = [];
  var batchReadTimer = null;

  function autoExecuteRead(actionData, cardId) {
    pendingReads.push({ actionData: actionData, cardId: cardId });

    // Debounce: wait for all reads from this render cycle to be queued
    if (batchReadTimer) clearTimeout(batchReadTimer);
    batchReadTimer = setTimeout(function() {
      batchReadTimer = null;
      processBatchReads();
    }, 200);
  }

  function processBatchReads() {
    if (pendingReads.length === 0) return;

    var reads = pendingReads.slice();
    pendingReads = [];

    // Execute all reads in parallel
    var fetches = reads.map(function(r) {
      return fetch(ACTION_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r.actionData)
      }).then(function(res) { return res.json(); }).then(function(result) {
        // Remove loading card
        var card = document.getElementById('read-card-' + r.cardId);
        if (card) card.remove();

        return {
          table: r.actionData.table,
          success: result.success,
          data: result.data
        };
      }).catch(function(err) {
        var card = document.getElementById('read-card-' + r.cardId);
        if (card) card.querySelector('.mr-action-card-body').innerHTML = '<span style="color:var(--color-danger);">Error: ' + esc(err.message) + '</span>';
        return { table: r.actionData.table, success: false, data: null };
      });
    });

    Promise.all(fetches).then(function(results) {
      // Clean up orphaned <br> tags left after card removal in the parent message
      var msgDivs = messagesEl.querySelectorAll('.mr-msg-ai');
      msgDivs.forEach(function(div) {
        // Strip runs of 3+ consecutive <br> down to one
        div.innerHTML = div.innerHTML.replace(/(<br\s*\/?>[\s\n]*){3,}/gi, '<br>');
        // Strip trailing <br> tags after the last real content
        div.innerHTML = div.innerHTML.replace(/(<br\s*\/?>[\s\n]*)+$/gi, '');
      });

      // Combine successful results into one context message
      var successResults = results.filter(function(r) { return r.success && r.data; });
      if (successResults.length === 0) return;

      var combinedData = successResults.map(function(r) {
        var dataStr = JSON.stringify(r.data, null, 2);
        if (dataStr.length > 3000) dataStr = dataStr.substring(0, 3000) + '\n... (truncated)';
        return '**' + r.table + ':**\n```json\n' + dataStr + '\n```';
      }).join('\n\n');

      // Push combined data as a hidden message (sent to API for context but not shown in chat)
      messages.push({
        role: 'assistant',
        content: 'I pulled the following data:\n\n' + combinedData,
        hidden: true
      });

      // Push single summarize instruction (also hidden)
      messages.push({
        role: 'user',
        content: '[System: The data above was auto-fetched from ' + successResults.length + ' source(s). Provide a single concise, conversational summary addressing the user\'s original question. Do NOT output any action blocks. Do NOT expose raw field names, table names, or JSON structure. Translate everything into plain English for the team.]',
        hidden: true
      });

      // Trigger single follow-up stream
      isAutoReadFollowUp = true;
      isStreaming = true;
      sendBtn.disabled = true;
      currentStreamText = '';
      displayedText = '';

      var aiDiv = document.createElement('div');
      aiDiv.className = 'mr-msg mr-msg-ai streaming';
      aiDiv.innerHTML = '<div class="mr-msg-label">COREBot</div>';
      messagesEl.appendChild(aiDiv);
      currentStreamEl = aiDiv;
      scrollToBottom(true);

      var apiMessages = messages.filter(function(m) {
        return m.role === 'user' || m.role === 'assistant';
      }).map(function(m) {
        return { role: m.role, content: m.content };
      });

      var ctx = getPageContext();

      fetch(CHAT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, context: ctx })
      })
      .then(function(response) {
        if (!response.ok) throw new Error('API error: ' + response.status);
        return readStream(response.body);
      })
      .catch(function(err) {
        finishStream();
        addSystemMessage('Error: ' + err.message);
      });
    });
  }

  function executeAction(cardId) {
    var card = messagesEl.querySelector('[data-card-id="' + cardId + '"]');
    if (!card) return;

    var actionData;
    try { actionData = JSON.parse(card.dataset.action); } catch(e) { return; }

    card.classList.add('executed');
    card.querySelector('.mr-action-card-actions').innerHTML = '<span style="font-size:.75rem;color:var(--color-warning);">Executing...</span>';

    fetch(ACTION_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(actionData)
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      if (result.success) {
        card.querySelector('.mr-action-card-actions').innerHTML = '<span style="font-size:.75rem;color:var(--color-success);">&#10003; Done</span>';
        addSystemMessage('Action executed successfully. Refreshing data...');
        // Trigger page data refresh if available
        if (typeof window.loadData === 'function') {
          setTimeout(window.loadData, 500);
        }
      } else {
        card.querySelector('.mr-action-card-actions').innerHTML = '<span style="font-size:.75rem;color:var(--color-danger);">Failed: ' + esc(result.error || 'Unknown error') + '</span>';
        card.classList.remove('executed');
      }
    })
    .catch(function(err) {
      card.querySelector('.mr-action-card-actions').innerHTML = '<span style="font-size:.75rem;color:var(--color-danger);">Error: ' + esc(err.message) + '</span>';
      card.classList.remove('executed');
    });
  }

  function skipAction(cardId) {
    var card = messagesEl.querySelector('[data-card-id="' + cardId + '"]');
    if (card) {
      card.classList.add('executed');
      card.querySelector('.mr-action-card-actions').innerHTML = '<span style="font-size:.75rem;color:var(--color-muted);">Skipped</span>';
    }
  }

  // ============================================================
  // SEND MESSAGE + STREAMING
  // ============================================================
  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || isStreaming) return;

    // Add user message
    messages.push({ role: 'user', content: text });
    inputEl.value = '';
    inputEl.style.height = 'auto';

    // Clear welcome if first message
    renderMessages();

    // Start streaming
    isStreaming = true;
    sendBtn.disabled = true;
    currentStreamText = '';
    userScrolledUp = false;

    // Add empty AI message placeholder
    var aiDiv = document.createElement('div');
    aiDiv.className = 'mr-msg mr-msg-ai streaming';
    aiDiv.innerHTML = '<div class="mr-msg-label">COREBot</div>';
    messagesEl.appendChild(aiDiv);
    currentStreamEl = aiDiv;
    scrollToBottom();

    // Build API messages (only user/assistant for Anthropic)
    var apiMessages = messages.filter(function(m) {
      return m.role === 'user' || m.role === 'assistant';
    }).map(function(m) {
      return { role: m.role, content: m.content };
    });

    var ctx = getPageContext();

    fetch(CHAT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: apiMessages, context: ctx })
    })
    .then(function(response) {
      if (!response.ok) {
        throw new Error('API error: ' + response.status);
      }
      return readStream(response.body);
    })
    .catch(function(err) {
      console.error('Chat error:', err);
      currentStreamEl.classList.remove('streaming');
      currentStreamEl.innerHTML += '<br><span style="color:var(--color-danger);font-size:.78rem;">Error: ' + esc(err.message) + '</span>';
      isStreaming = false;
      sendBtn.disabled = false;
    });
  }

  function readStream(body) {
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    function processChunk() {
      return reader.read().then(function(result) {
        if (result.done) {
          finishStream();
          return;
        }

        buffer += decoder.decode(result.value, { stream: true });

        // Parse SSE events from buffer
        var lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.startsWith('event: model_info')) {
            // Next data line has model fallback info
            continue;
          }
          if (line.startsWith('data: ')) {
            var data = line.slice(6);
            if (data === '[DONE]') {
              finishStream();
              return;
            }
            try {
              var parsed = JSON.parse(data);
              // Check if this is model_info data
              if (parsed.model && parsed.label && !parsed.type) {
                var sub = document.querySelector('.mr-chat-header-sub');
                if (sub) sub.textContent = parsed.label + ' (fallback)';
                addSystemMessage('Using ' + parsed.label + ' due to high Opus demand.');
                continue;
              }
              handleSSEEvent(parsed);
            } catch(e) {
              // Skip unparseable events
            }
          }
        }

        return processChunk();
      });
    }

    return processChunk();
  }

  function handleSSEEvent(event) {
    var type = event.type;

    if (type === 'content_block_delta') {
      var delta = event.delta;
      if (delta && delta.type === 'text_delta' && delta.text) {
        currentStreamText += delta.text;
        updateStreamDisplay();
      }
    } else if (type === 'message_stop') {
      finishStream();
    } else if (type === 'error') {
      currentStreamText += '\n\n[Error: ' + (event.error && event.error.message || 'Unknown') + ']';
      updateStreamDisplay();
      finishStream();
    }
  }

  var displayedText = '';
  var isAutoReadFollowUp = false;
  var executedReadIds = {}; // persistent map of read card IDs that have already fired
  var suppressedReadCount = 0; // tracks reads suppressed by context guard per render cycle
  var typewriterTimer = null;
  var TYPEWRITER_SPEED = 8; // ms per character - very fast but smooth

  // While streaming, avoid slicing mid-markdown-token (e.g. mid `**`, mid `[label](url)`).
  // Find a safe render boundary at or before `idx`.
  function safeStreamBoundary(full, idx) {
    if (idx >= full.length) return idx;
    var slice = full.slice(0, idx);
    // Unclosed markdown link: ` [label]( ... ` with no matching `)` yet.
    var lastOpenParen = slice.lastIndexOf('](');
    if (lastOpenParen !== -1 && slice.lastIndexOf(')') < lastOpenParen) {
      var lastBracket = slice.lastIndexOf('[');
      if (lastBracket !== -1) return lastBracket;
    }
    // Unclosed code span: odd count of backticks.
    var backticks = (slice.match(/`/g) || []).length;
    if (backticks % 2 === 1) { var lastBt = slice.lastIndexOf('`'); if (lastBt !== -1) return lastBt; }
    // Odd count of `**` pairs → last `*` is mid-bold.
    var starPairs = (slice.match(/\*\*/g) || []).length;
    if (starPairs % 2 === 1) { var lastPair = slice.lastIndexOf('**'); if (lastPair !== -1) return lastPair; }
    return idx;
  }

  function startTypewriter() {
    if (typewriterTimer) return;
    typewriterTimer = setInterval(function() {
      if (!currentStreamEl) { clearInterval(typewriterTimer); typewriterTimer = null; return; }
      if (displayedText.length < currentStreamText.length) {
        // Reveal multiple chars per tick for speed (up to 4)
        var charsToAdd = Math.min(4, currentStreamText.length - displayedText.length);
        var nextIdx = displayedText.length + charsToAdd;
        if (isStreaming) nextIdx = safeStreamBoundary(currentStreamText, nextIdx);
        if (nextIdx > displayedText.length) {
          displayedText = currentStreamText.substring(0, nextIdx);
          renderStreamContent();
        }
      } else if (!isStreaming) {
        // Streaming done and caught up
        clearInterval(typewriterTimer);
        typewriterTimer = null;
      }
    }, TYPEWRITER_SPEED);
  }

  function renderStreamContent() {
    if (!currentStreamEl) return;
    requestAnimationFrame(function() {
      if (!currentStreamEl) return;
      currentStreamEl.innerHTML = '<div class="mr-msg-label">COREBot</div>' + formatAIMessage(displayedText, messages.length);
      scrollToBottom();
    });
  }

  function updateStreamDisplay() {
    if (!currentStreamEl) return;
    startTypewriter();
  }

  function finishStream() {
    if (!isStreaming) return;
    isStreaming = false;
    isAutoReadFollowUp = false;
    sendBtn.disabled = false;

    // Flush any remaining buffered text
    if (typewriterTimer) { clearInterval(typewriterTimer); typewriterTimer = null; }
    displayedText = currentStreamText;

    // Reset suppression counter BEFORE any rendering
    suppressedReadCount = 0;
    
    if (currentStreamEl) {
      currentStreamEl.classList.remove('streaming');
      if (currentStreamText) {
        currentStreamEl.innerHTML = '<div class="mr-msg-label">COREBot</div>' + formatAIMessage(currentStreamText, messages.length);
      }
    }

    if (currentStreamText) {
      messages.push({ role: 'assistant', content: currentStreamText });
      saveHistory();
    }

    // Re-render to bind action buttons properly
    renderMessages();

    currentStreamEl = null;
    currentStreamText = '';
    displayedText = '';
    if (typewriterTimer) { clearInterval(typewriterTimer); typewriterTimer = null; }
  }

  function addSystemMessage(text) {
    messages.push({ role: 'system', content: text });
    saveHistory();
    renderMessages();
  }

  // ============================================================
  // UTILITIES
  // ============================================================
  var userScrolledUp = false;

  // Detect if user has scrolled up to read
  messagesEl.addEventListener('scroll', function() {
    var atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
    userScrolledUp = !atBottom;
  });

  function scrollToBottom(force) {
    if (force || !userScrolledUp) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function saveHistory() {
    try {
      // Keep last 50 messages to avoid session storage limits
      var toSave = messages.slice(-50);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(toSave));
    } catch(e) {}
  }

  function clearHistory() {
    messages = [];
    try { sessionStorage.removeItem(SESSION_KEY); } catch(e) {}
    renderMessages();
  }

  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ============================================================
  // ============================================================
  // FETCH LIGHTWEIGHT CLIENT INDEX (all admin pages)
  // ============================================================
  var clientIndex = null;
  (function fetchClientIndex() {
    var SB_URL = 'https://ofmmwcjhdrhvxxkhcuww.supabase.co/rest/v1';
    var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mbW13Y2poZHJodnh4a2hjdXd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzMjM1NTcsImV4cCI6MjA4OTg5OTU1N30.zMMHW0Fk9ixWjORngyxJTIoPOfx7GFsD4wBV4Foqqms';
    fetch(SB_URL + '/contacts?select=id,slug,status,practice_name,first_name,last_name,email,lost&order=practice_name', {
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
    }).then(function(r) { return r.json(); }).then(function(data) {
      clientIndex = data;
      console.log('Chat: loaded client index (' + data.length + ' clients)');
    }).catch(function(e) { console.warn('Chat: failed to load client index', e); });
  })();

  // PUBLIC API - pages can set context
  // ============================================================
  window.MoonrakerChat = {
    setContext: function(ctx) {
      window._mrChatContext = ctx;
      if (panelOpen) updateContextDisplay();
    },
    open: function() { togglePanel(true); },
    close: function() { togglePanel(false); },
    send: function(text) {
      inputEl.value = text;
      sendMessage();
    }
  };

})();











