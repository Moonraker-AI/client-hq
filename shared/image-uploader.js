// /shared/image-uploader.js
//
// Pagemaster v2 reusable image uploader widget (v2 — tabbed UI).
//
// Renders into a container element with three tabbed input modes (Upload,
// Library, Generate), an inline-extending grid below, and per-tile remove.
// AI generations stage as drafts that the user must Accept or Discard before
// they enter the pool.
//
//   1. Upload   → /api/upload-image-init → Storage PUT → /api/upload-image-complete
//   2. Library  → /api/search-stock-images → /api/process-stock-pick
//   3. Generate → /api/generate-pool-image  (status='draft' until accepted)
//
// All three result in client_image_pool rows. Direct uploads + accepted
// stock + accepted generations land as status='pending' and the widget
// polls /api/upload-image-status to flip thumbnails to 'ready' with the
// final hosted_url.
//
// Usage:
//   <div id="my-uploader" data-contact-id="..." data-category="practice"></div>
//   <script src="/shared/image-uploader.js" defer></script>
//   <script>
//     window.MRImageUploader.mount('#my-uploader', {
//       contactId: '...',
//       category: 'practice',           // 'practice'|'logo'|'headshot'|'credential'|'hero'|'misc'
//       maxFiles: 0,                    // 0 = unlimited
//       allowStock: true,
//       allowGenerate: true,
//       onChange: function(items) { ... },
//     });
//   </script>
//
// Auth: this widget runs on client-facing onboarding pages (cookie page-token
// scope='onboarding') AND admin pages (admin JWT cookie). The widget itself
// is auth-agnostic; the API routes do the auth check.

(function (root) {
  'use strict';

  // Module-level shared state for poll batching across multiple widgets
  // on the same page.
  var pendingByContact = {};   // contactId -> Set of pool_ids
  var pollTimer = null;
  var POLL_INTERVAL_MS = 2200;

  // Stock library categories shown as chips in the Library tab.
  // Ordered by frequency of use for therapy practices.
  var STOCK_CATEGORIES = [
    { value: 'office',       label: 'Office' },
    { value: 'exterior',     label: 'Exterior' },
    { value: 'nature',       label: 'Nature' },
    { value: 'hands',        label: 'Hands & connection' },
    { value: 'abstract',     label: 'Abstract' },
    { value: 'people',       label: 'People' },
    { value: 'wellness',     label: 'Wellness' }
  ];

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtBytes(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ── API helpers ────────────────────────────────────────────

  function apiPost(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data && data.error || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function apiGet(path) {
    return fetch(path, { credentials: 'same-origin' }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data && data.error || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function putToSignedUrl(uploadUrl, file) {
    return fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error('Storage PUT failed: ' + r.status + ' / ' + (t || '').substring(0, 120));
        });
      }
      return true;
    });
  }

  // ── Polling (one batch per contact, regardless of widget count) ─

  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
  }

  function stopPollingIfIdle() {
    var hasPending = Object.keys(pendingByContact).some(function (cid) {
      return pendingByContact[cid] && pendingByContact[cid].size > 0;
    });
    if (!hasPending && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollAll() {
    Object.keys(pendingByContact).forEach(function (contactId) {
      var set = pendingByContact[contactId];
      if (!set || set.size === 0) return;
      var ids = Array.from(set);
      apiGet('/api/upload-image-status?contact_id=' + encodeURIComponent(contactId) + '&pool_ids=' + ids.join(','))
        .then(function (resp) {
          var items = resp.items || [];
          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.status === 'ready' || item.status === 'failed') {
              set.delete(item.id);
              fireUpdate(contactId, item);
            }
          }
          stopPollingIfIdle();
        })
        .catch(function (err) {
          console.warn('[image-uploader] poll error:', err.message);
        });
    });
  }

  var subscribersByContact = {};

  function subscribe(contactId, fn) {
    if (!subscribersByContact[contactId]) subscribersByContact[contactId] = [];
    subscribersByContact[contactId].push(fn);
    return function unsub() {
      var arr = subscribersByContact[contactId] || [];
      var i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    };
  }

  function fireUpdate(contactId, item) {
    var subs = subscribersByContact[contactId] || [];
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](item); } catch (e) { console.warn(e); }
    }
  }

  function trackPending(contactId, poolId) {
    if (!pendingByContact[contactId]) pendingByContact[contactId] = new Set();
    pendingByContact[contactId].add(poolId);
    ensurePolling();
  }

  // ── Uploader instance ────────────────────────────────────

  function mount(target, opts) {
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('mount target not found');

    var contactId = opts.contactId || el.dataset.contactId;
    if (!contactId) throw new Error('contactId required');

    var category = opts.category || el.dataset.category || 'practice';
    var maxFiles = opts.maxFiles == null ? 0 : opts.maxFiles;
    var allowStock = opts.allowStock !== false;
    var allowGenerate = opts.allowGenerate !== false;
    var onChange = opts.onChange || function () {};

    // Pool items (accepted, in client_image_pool).
    // Drafts (AI generations awaiting accept/discard) live separately so
    // they don't pollute the persistent grid until the user commits.
    var items = [];
    var drafts = [];   // [{ id (gen_xxx), pool_id, hosted_url, prompt, status, error }]
    var stockResults = [];   // last library search results
    var stockLoading = false;
    var activeTab = null;    // null = tabs collapsed; default for first open

    el.classList.add('mr-uploader');
    if (maxFiles === 1) el.classList.add('mr-uploader--single');
    var tabCount = 1 + (allowStock ? 1 : 0) + (allowGenerate ? 1 : 0);
    if (tabCount === 1) el.setAttribute('data-single-mode', 'true');
    el.innerHTML = renderShell({
      category: category,
      allowStock: allowStock,
      allowGenerate: allowGenerate
    });

    var tabsEl = el.querySelector('.mr-up__tabs');
    var panelsEl = el.querySelector('.mr-up__panels');
    var grid = el.querySelector('.mr-up__grid');

    refreshExisting();

    var unsubscribe = subscribe(contactId, function (statusItem) {
      var idx = items.findIndex(function (it) { return it.id === statusItem.id; });
      if (idx === -1) return;
      items[idx] = Object.assign({}, items[idx], statusItem);
      renderGrid();
      onChange(items);
    });

    bindTabs();
    // Default: open Upload tab so the drop zone is immediately visible.
    openTab('upload');

    // ── Tab switching ──────────────────────────────────────

    function bindTabs() {
      tabsEl.querySelectorAll('.mr-up__tab').forEach(function (btn) {
        btn.addEventListener('click', function () {
          openTab(btn.dataset.tab);
        });
      });
    }

    function openTab(tab) {
      activeTab = tab;
      tabsEl.querySelectorAll('.mr-up__tab').forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.tab === activeTab);
      });
      renderPanels();
    }

    // ── Panel rendering ────────────────────────────────────

    function renderPanels() {
      if (!activeTab) {
        panelsEl.innerHTML = '';
        panelsEl.classList.remove('is-open');
        return;
      }
      panelsEl.classList.add('is-open');
      if (activeTab === 'upload') panelsEl.innerHTML = renderUploadPanel();
      else if (activeTab === 'library') panelsEl.innerHTML = renderLibraryPanel();
      else if (activeTab === 'generate') panelsEl.innerHTML = renderGeneratePanel();
      bindPanelHandlers();
    }

    function renderUploadPanel() {
      var hint = {
        practice: 'Drop photos of your practice (office, lobby, exterior, neighborhood, team candids).',
        logo: 'Drop your practice logo. PNG with a transparent background works best.',
        headshot: 'Drop a professional headshot.',
        credential: 'Drop photos of diplomas, certificates, or licenses.',
        hero: 'Drop a hero or banner image.',
        misc: 'Drop any image.'
      }[category] || 'Drop photos here.';
      return [
        '<div class="mr-up__drop">',
        '  <input type="file" class="mr-up__file-input" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple style="display:none;">',
        '  <div class="mr-up__drop-icon">📷</div>',
        '  <div class="mr-up__drop-title">Drop photos here or tap to choose</div>',
        '  <div class="mr-up__drop-hint">' + escapeHtml(hint) + '</div>',
        '</div>'
      ].join('');
    }

    function renderLibraryPanel() {
      var chips = STOCK_CATEGORIES.map(function (c) {
        return '<button type="button" class="mr-up__chip" data-stock-cat="' + escapeHtml(c.value) + '">' + escapeHtml(c.label) + '</button>';
      }).join('');
      var gridHtml;
      if (stockLoading) {
        gridHtml = '<div class="mr-up__lib-empty">Loading…</div>';
      } else if (!stockResults.length) {
        gridHtml = '<div class="mr-up__lib-empty">Pick a category or search to browse the library.</div>';
      } else {
        gridHtml = stockResults.map(function (s) {
          var addedItem = items.find(function (it) { return it.stock_image_id === s.id; });
          var alreadyAdded = !!addedItem;
          return [
            '<div class="mr-up__lib-tile' + (alreadyAdded ? ' is-added' : '') + '" data-stock-id="' + s.id + '"' + (alreadyAdded && addedItem.id ? ' data-pool-id="' + escapeHtml(addedItem.id) + '"' : '') + '>',
            '  <img src="' + escapeHtml(s.hosted_url) + '" alt="' + escapeHtml(s.rich_description || '') + '" loading="lazy" data-expand-src="' + escapeHtml(s.hosted_url) + '" data-expand-alt="' + escapeHtml(s.rich_description || '') + '">',
            '  <button type="button" class="mr-up__lib-icon" data-stock-id="' + s.id + '" aria-label="' + (alreadyAdded ? 'Remove' : 'Add') + '">' + (alreadyAdded ? '×' : '+') + '</button>',
            '</div>'
          ].join('');
        }).join('');
      }
      return [
        '<div class="mr-up__lib">',
        '  <div class="mr-up__lib-bar">',
        '    <input type="text" class="mr-up__lib-search" placeholder="Search the library…" value="">',
        '    <button type="button" class="mr-up__lib-search-btn">Search</button>',
        '  </div>',
        '  <div class="mr-up__lib-chips">' + chips + '</div>',
        '  <div class="mr-up__lib-grid">' + gridHtml + '</div>',
        '</div>'
      ].join('');
    }

    function renderGeneratePanel() {
      var draftsHtml = drafts.length ? [
        '<div class="mr-up__draft-label">Drafts. Accept the ones you want, discard the rest:</div>',
        '<div class="mr-up__draft-grid">',
        drafts.map(function (d) {
          if (d.status === 'failed') {
            return [
              '<div class="mr-up__draft-tile is-failed" data-draft-id="' + escapeHtml(d.id) + '">',
              '  <div class="mr-up__draft-fail">Generation failed' + (d.error ? '<br><span>' + escapeHtml(d.error) + '</span>' : '') + '</div>',
              '  <button type="button" class="mr-up__draft-discard" data-draft-id="' + escapeHtml(d.id) + '">Dismiss</button>',
              '</div>'
            ].join('');
          }
          if (d.status === 'generating') {
            return [
              '<div class="mr-up__draft-tile is-loading" data-draft-id="' + escapeHtml(d.id) + '">',
              '  <div class="mr-up__draft-spin">',
              '    <div class="mr-up__spinner"></div>',
              '    <div class="mr-up__draft-spin-label">Generating</div>',
              '    <div class="mr-up__draft-spin-sub">30 to 60 seconds</div>',
              '  </div>',
              '</div>'
            ].join('');
          }
          return [
            '<div class="mr-up__draft-tile" data-draft-id="' + escapeHtml(d.id) + '">',
            '  <img src="' + escapeHtml(d.hosted_url) + '" alt="" data-expand-src="' + escapeHtml(d.hosted_url) + '">',
            '  <div class="mr-up__draft-actions">',
            '    <button type="button" class="mr-up__draft-accept" data-draft-id="' + escapeHtml(d.id) + '">Accept</button>',
            '    <button type="button" class="mr-up__draft-discard" data-draft-id="' + escapeHtml(d.id) + '">Discard</button>',
            '  </div>',
            '</div>'
          ].join('');
        }).join(''),
        '</div>'
      ].join('') : '';

      return [
        '<div class="mr-up__gen">',
        '  <label class="mr-up__gen-label">Describe the image you want</label>',
        '  <textarea class="mr-up__gen-prompt" rows="2" placeholder="e.g. warm therapy office with plants and natural light, soft morning sun"></textarea>',
        '  <div class="mr-up__gen-bar">',
        '    <span class="mr-up__gen-hint">Generation usually takes 30 to 60 seconds. Tap an image to preview, then accept or discard.</span>',
        '    <button type="button" class="mr-up__gen-btn">Generate ✨</button>',
        '  </div>',
        '  ' + draftsHtml,
        '</div>'
      ].join('');
    }

    function bindPanelHandlers() {
      if (activeTab === 'upload') {
        var dropZone = panelsEl.querySelector('.mr-up__drop');
        var fileInput = panelsEl.querySelector('.mr-up__file-input');
        ['dragenter', 'dragover'].forEach(function (ev) {
          dropZone.addEventListener(ev, function (e) {
            e.preventDefault(); e.stopPropagation();
            dropZone.classList.add('is-dragover');
          });
        });
        ['dragleave', 'drop'].forEach(function (ev) {
          dropZone.addEventListener(ev, function (e) {
            e.preventDefault(); e.stopPropagation();
            dropZone.classList.remove('is-dragover');
          });
        });
        dropZone.addEventListener('drop', function (e) {
          var files = e.dataTransfer && e.dataTransfer.files;
          if (files && files.length) handleFiles(files);
        });
        dropZone.addEventListener('click', function () { fileInput.click(); });
        fileInput.addEventListener('change', function (e) {
          if (e.target.files && e.target.files.length) handleFiles(e.target.files);
          e.target.value = '';
        });
      } else if (activeTab === 'library') {
        var searchBtn = panelsEl.querySelector('.mr-up__lib-search-btn');
        var searchInput = panelsEl.querySelector('.mr-up__lib-search');
        searchBtn.addEventListener('click', function () { runStockSearch(searchInput.value.trim()); });
        searchInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); runStockSearch(searchInput.value.trim()); }
        });
        panelsEl.querySelectorAll('.mr-up__chip').forEach(function (chip) {
          chip.addEventListener('click', function () {
            panelsEl.querySelectorAll('.mr-up__chip').forEach(function (c) { c.classList.remove('is-active'); });
            chip.classList.add('is-active');
            runStockSearch(chip.dataset.stockCat);
          });
        });
        panelsEl.querySelectorAll('.mr-up__lib-tile').forEach(function (tile) {
          // Click image → expand preview modal
          var img = tile.querySelector('img');
          if (img) {
            img.addEventListener('click', function (e) {
              e.stopPropagation();
              showExpandModal(img.dataset.expandSrc || img.src, img.dataset.expandAlt || '');
            });
          }
          // Click + / × icon → add or remove
          var icon = tile.querySelector('.mr-up__lib-icon');
          if (icon) {
            icon.addEventListener('click', function (e) {
              e.stopPropagation();
              var stockId = parseInt(tile.dataset.stockId, 10);
              if (tile.classList.contains('is-added')) {
                // Remove via stored pool_id
                var poolId = tile.dataset.poolId;
                if (poolId) removeOneById(poolId);
              } else {
                var stock = stockResults.find(function (s) { return s.id === stockId; });
                if (stock) addStockOne(stock, tile);
              }
            });
          }
        });
      } else if (activeTab === 'generate') {
        var genBtn = panelsEl.querySelector('.mr-up__gen-btn');
        var promptEl = panelsEl.querySelector('.mr-up__gen-prompt');
        genBtn.addEventListener('click', function () {
          var p = promptEl.value.trim();
          if (!p) return;
          startGenerate(p);
          promptEl.value = '';
        });
        panelsEl.querySelectorAll('.mr-up__draft-tile img').forEach(function (img) {
          img.addEventListener('click', function (e) {
            e.stopPropagation();
            showExpandModal(img.dataset.expandSrc || img.src, '');
          });
        });
        panelsEl.querySelectorAll('.mr-up__draft-accept').forEach(function (btn) {
          btn.addEventListener('click', function () { acceptDraft(btn.dataset.draftId); });
        });
        panelsEl.querySelectorAll('.mr-up__draft-discard').forEach(function (btn) {
          btn.addEventListener('click', function () { discardDraft(btn.dataset.draftId); });
        });
      }
    }

    // ── Direct upload flow ─────────────────────────────────

    function handleFiles(fileList) {
      var arr = Array.from(fileList);
      if (maxFiles > 0) {
        var remaining = Math.max(0, maxFiles - items.length);
        if (remaining === 0) {
          alert('Maximum ' + maxFiles + ' image(s) allowed in this section. Remove one first.');
          return;
        }
        arr = arr.slice(0, remaining);
      }
      arr.forEach(uploadOne);
    }

    function uploadOne(file) {
      var localId = 'local-' + Math.random().toString(36).slice(2, 8);
      var localUrl = URL.createObjectURL(file);
      var placeholder = {
        id: localId,
        status: 'uploading',
        hosted_url: localUrl,
        filename: file.name,
        bytes: file.size,
        local: true,
      };
      items.push(placeholder);
      renderGrid();

      apiPost('/api/upload-image-init', {
        contact_id: contactId,
        category: category,
        filename: file.name,
        mime_type: file.type || 'image/jpeg',
        bytes: file.size,
      }).then(function (initResp) {
        var idx = items.findIndex(function (it) { return it.id === localId; });
        if (idx !== -1) {
          items[idx] = Object.assign({}, items[idx], { id: initResp.pool_id, status: 'uploading' });
          renderGrid();
        }
        return putToSignedUrl(initResp.upload_url, file)
          .then(function () {
            return apiPost('/api/upload-image-complete', {
              pool_id: initResp.pool_id,
              contact_id: contactId,
            });
          })
          .then(function () {
            var i2 = items.findIndex(function (it) { return it.id === initResp.pool_id; });
            if (i2 !== -1) {
              items[i2] = Object.assign({}, items[i2], { status: 'pending', local: false });
              renderGrid();
            }
            trackPending(contactId, initResp.pool_id);
          });
      }).catch(function (err) {
        console.error('[image-uploader] upload error:', err);
        var idx = items.findIndex(function (it) { return it.id === localId; });
        if (idx !== -1) {
          items[idx] = Object.assign({}, items[idx], { status: 'failed', error: err.message });
          renderGrid();
        }
      });
    }

    // ── Stock library flow ─────────────────────────────────

    function runStockSearch(query) {
      stockLoading = true;
      renderPanels();
      apiPost('/api/search-stock-images', { query: query || '', contact_id: contactId, limit: 60 })
        .then(function (resp) {
          stockLoading = false;
          stockResults = resp.stock || [];
          renderPanels();
        })
        .catch(function (err) {
          stockLoading = false;
          stockResults = [];
          renderPanels();
          alert('Library search failed: ' + err.message);
        });
    }

    function addStockOne(stock, tile) {
      if (maxFiles > 0 && items.length >= maxFiles) {
        alert('Maximum ' + maxFiles + ' image(s) allowed. Remove one first.');
        return;
      }
      tile.classList.add('is-adding');
      var localId = 'stock-' + stock.id;
      items.push({
        id: localId,
        status: 'uploading',
        hosted_url: stock.hosted_url,
        filename: 'stock-' + stock.id,
        stock_image_id: stock.id,
        local: true,
      });
      renderGrid();
      apiPost('/api/process-stock-pick', {
        contact_id: contactId,
        category: category,
        stock_image_ids: [stock.id],
      }).then(function (pickResp) {
        var r = (pickResp.items || [])[0];
        var idx = items.findIndex(function (it) { return it.id === localId; });
        if (idx === -1) return;
        if (r && r.ok) {
          items[idx] = Object.assign({}, items[idx], {
            id: r.pool_id,
            status: r.existing ? 'ready' : 'pending',
            local: false,
            stock_image_id: stock.id,
          });
          if (!r.existing) trackPending(contactId, r.pool_id);
        } else {
          items[idx] = Object.assign({}, items[idx], {
            status: 'failed',
            error: r && r.error || 'Failed',
          });
        }
        renderGrid();
        if (activeTab === 'library') renderPanels();   // refresh +/× state
        onChange(items);
      }).catch(function (err) {
        var idx = items.findIndex(function (it) { return it.id === localId; });
        if (idx !== -1) {
          items[idx] = Object.assign({}, items[idx], { status: 'failed', error: err.message });
          renderGrid();
        }
        alert('Could not add: ' + err.message);
      });
    }

    // Remove an existing pool item by its pool_id (used by library × icon)
    function removeOneById(id) {
      var idx = items.findIndex(function (it) { return it.id === id; });
      if (idx === -1) return;
      items.splice(idx, 1);
      renderGrid();
      if (activeTab === 'library') renderPanels();
      onChange(items);
      if (!String(id).startsWith('local-') && !String(id).startsWith('stock-') && !String(id).startsWith('gen-')) {
        apiPost('/api/archive-pool-image', { contact_id: contactId, pool_id: id })
          .catch(function () { /* non-critical */ });
      }
    }

    // ── AI generate flow (drafts) ──────────────────────────

    function startGenerate(prompt) {
      var draftId = 'gen-' + Math.random().toString(36).slice(2, 8);
      drafts.push({ id: draftId, status: 'generating', hosted_url: '', prompt: prompt });
      renderPanels();
      apiPost('/api/generate-pool-image', {
        contact_id: contactId,
        category: category,
        prompt: prompt,
        as_draft: true,
      }).then(function (resp) {
        var d = drafts.find(function (x) { return x.id === draftId; });
        if (!d) return;
        d.pool_id = resp.pool_id;
        d.hosted_url = resp.hosted_url || '';
        if (resp.hosted_url) {
          d.status = 'ready';
          renderPanels();
        } else {
          pollDraft(draftId, resp.pool_id);
        }
      }).catch(function (err) {
        var d = drafts.find(function (x) { return x.id === draftId; });
        if (d) { d.status = 'failed'; d.error = err.message; renderPanels(); }
      });
    }

    function pollDraft(draftId, poolId) {
      var attempts = 0;
      var maxAttempts = 60;   // ~2 min at 2s
      var iv = setInterval(function () {
        attempts++;
        apiGet('/api/upload-image-status?contact_id=' + encodeURIComponent(contactId) + '&pool_ids=' + poolId)
          .then(function (resp) {
            var item = (resp.items || [])[0];
            if (!item) return;
            var d = drafts.find(function (x) { return x.id === draftId; });
            if (!d) { clearInterval(iv); return; }
            if (item.status === 'ready') {
              d.status = 'ready';
              d.hosted_url = item.hosted_url;
              clearInterval(iv);
              renderPanels();
            } else if (item.status === 'failed') {
              d.status = 'failed';
              d.error = item.error || 'Generation failed';
              clearInterval(iv);
              renderPanels();
            }
          })
          .catch(function () { /* retry next tick */ });
        if (attempts >= maxAttempts) {
          clearInterval(iv);
          var d = drafts.find(function (x) { return x.id === draftId; });
          if (d && d.status === 'generating') {
            d.status = 'failed';
            d.error = 'Timed out waiting for generation';
            renderPanels();
          }
        }
      }, 2000);
    }

    function acceptDraft(draftId) {
      if (maxFiles > 0 && items.length >= maxFiles) {
        alert('Maximum ' + maxFiles + ' image(s) allowed. Remove one first.');
        return;
      }
      var d = drafts.find(function (x) { return x.id === draftId; });
      if (!d || d.status !== 'ready' || !d.pool_id) return;
      apiPost('/api/accept-pool-draft', {
        contact_id: contactId,
        pool_id: d.pool_id,
      }).then(function () {
        items.push({
          id: d.pool_id,
          status: 'ready',
          hosted_url: d.hosted_url,
          filename: 'generated',
          generated: true,
        });
        drafts = drafts.filter(function (x) { return x.id !== draftId; });
        renderGrid();
        renderPanels();
        onChange(items);
      }).catch(function (err) {
        alert('Could not accept: ' + err.message);
      });
    }

    function discardDraft(draftId) {
      var d = drafts.find(function (x) { return x.id === draftId; });
      drafts = drafts.filter(function (x) { return x.id !== draftId; });
      renderPanels();
      if (d && d.pool_id) {
        apiPost('/api/archive-pool-image', { contact_id: contactId, pool_id: d.pool_id })
          .catch(function () { /* non-critical */ });
      }
    }

    // ── Initial fetch + grid render ────────────────────────

    function refreshExisting() {
      apiGet('/api/list-pool-images?contact_id=' + encodeURIComponent(contactId) + '&category=' + encodeURIComponent(category))
        .then(function (resp) {
          var existing = (resp.items || []).filter(function (it) {
            // Drafts (unaccepted AI generations) don't show in the main grid
            if (it.status === 'draft') return false;
            if (opts.bioMaterialId && it.bio_material_id !== opts.bioMaterialId) return false;
            return true;
          });
          var sessionIds = new Set(items.map(function (it) { return it.id; }));
          existing.forEach(function (it) {
            if (!sessionIds.has(it.id)) items.push(it);
          });
          existing.forEach(function (it) {
            if (it.status === 'pending') trackPending(contactId, it.id);
          });
          renderGrid();
          onChange(items);
        })
        .catch(function (err) {
          console.warn('[image-uploader] refresh failed:', err.message);
        });
    }

    function renderGrid() {
      // Single-mode (maxFiles===1) widgets hide the input area once a photo
      // is in. We toggle a class on the root so CSS can collapse the tabs +
      // panels to make it obvious there's no more to do.
      el.classList.toggle('has-items', items.length > 0);

      if (!items.length) {
        grid.innerHTML = '<div class="mr-up__grid-empty">No photos yet. Add some using the options above.</div>';
        return;
      }
      grid.innerHTML = items.map(function (it) {
        var statusBadge =
          it.status === 'failed' ? '<span class="mr-up__badge mr-up__badge--failed">Failed</span>' :
          it.status === 'pending' ? '<span class="mr-up__badge mr-up__badge--pending">Processing (up to 2 min)</span>' :
          it.status === 'uploading' ? '<span class="mr-up__badge mr-up__badge--pending">Uploading</span>' :
          '';
        var imgHtml = it.hosted_url
          ? '<img src="' + escapeHtml(it.hosted_url) + '" alt="' + escapeHtml(it.alt_text || it.filename || '') + '">'
          : '<div class="mr-up__no-img">⏳</div>';
        var bytesLabel = it.bytes ? '<span class="mr-up__bytes">' + escapeHtml(fmtBytes(it.bytes)) + '</span>' : '';
        return [
          '<div class="mr-up__tile' + (it.status === 'failed' ? ' is-failed' : '') + (it.status === 'pending' || it.status === 'uploading' ? ' is-loading' : '') + '" data-id="' + escapeHtml(it.id) + '">',
          imgHtml,
          statusBadge,
          '<button class="mr-up__remove" type="button" aria-label="Remove" data-id="' + escapeHtml(it.id) + '">×</button>',
          bytesLabel,
          '</div>',
        ].join('');
      }).join('');

      grid.querySelectorAll('.mr-up__remove').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = btn.dataset.id;
          var idx = items.findIndex(function (it) { return it.id === id; });
          if (idx === -1) return;
          items.splice(idx, 1);
          renderGrid();
          if (activeTab === 'library') renderPanels();   // refresh "Added" badges
          onChange(items);
          if (!String(id).startsWith('local-') && !String(id).startsWith('stock-') && !String(id).startsWith('gen-')) {
            apiPost('/api/archive-pool-image', { contact_id: contactId, pool_id: id })
              .catch(function () { /* non-critical */ });
          }
        });
      });

      onChange(items);
    }

    return {
      destroy: function () {
        unsubscribe();
        el.innerHTML = '';
      },
      getItems: function () { return items.slice(); },
    };
  }

  // Modal preview for stock + AI draft images. Click backdrop / × to dismiss.
  function showExpandModal(src, alt) {
    var existing = document.querySelector('.mr-up-modal');
    if (existing) existing.remove();
    var modal = document.createElement('div');
    modal.className = 'mr-up-modal';
    modal.innerHTML = [
      '<div class="mr-up-modal__backdrop"></div>',
      '<div class="mr-up-modal__panel">',
      '  <button type="button" class="mr-up-modal__close" aria-label="Close">×</button>',
      '  <img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt || '') + '">',
      '</div>'
    ].join('');
    document.body.appendChild(modal);
    var close = function () { modal.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    modal.querySelector('.mr-up-modal__backdrop').addEventListener('click', close);
    modal.querySelector('.mr-up-modal__close').addEventListener('click', close);
  }

  function renderShell(opts) {
    var tabs = [];
    tabs.push('<button type="button" class="mr-up__tab" data-tab="upload">⬆ Upload</button>');
    if (opts.allowStock) tabs.push('<button type="button" class="mr-up__tab" data-tab="library">📚 Library</button>');
    if (opts.allowGenerate) tabs.push('<button type="button" class="mr-up__tab" data-tab="generate">✨ Generate</button>');

    return [
      '<div class="mr-up__tabs">' + tabs.join('') + '</div>',
      '<div class="mr-up__panels"></div>',
      '<div class="mr-up__grid"></div>',
    ].join('');
  }

  function injectStyles() {
    if (document.getElementById('mr-uploader-styles')) return;
    var style = document.createElement('style');
    style.id = 'mr-uploader-styles';
    style.textContent = MR_UPLOADER_CSS;
    document.head.appendChild(style);
  }

  var MR_UPLOADER_CSS = [
    '.mr-uploader { display: flex; flex-direction: column; gap: 0.875rem; }',

    '.mr-up__tabs { display: flex; gap: 0.5rem; flex-wrap: wrap; }',
    '.mr-uploader[data-single-mode="true"] .mr-up__tabs { display: none; }',
    '.mr-uploader[data-single-mode="true"] .mr-up__panels.is-open { padding: 0; border: 0; background: transparent; }',
    '.mr-up__tab { padding: 0.5rem 0.875rem; border-radius: 8px; border: 1px solid var(--color-border, rgba(0,0,0,0.12)); background: var(--color-surface, #fff); cursor: pointer; font-weight: 500; font-size: 0.875rem; color: var(--color-body, inherit); transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease; }',
    '.mr-up__tab:hover { background: rgba(0,212,126,0.06); border-color: var(--color-accent, #00d47e); }',
    '.mr-up__tab.is-active { background: var(--color-accent, #00d47e); color: #fff; border-color: var(--color-accent, #00d47e); }',

    '.mr-up__panels { display: none; }',
    '.mr-up__panels.is-open { display: block; border: 1px solid var(--color-border, rgba(0,0,0,0.1)); border-radius: 12px; padding: 1rem; background: var(--color-surface, #fff); }',

    '.mr-up__drop { border: 2px dashed rgba(0,0,0,0.18); border-radius: 10px; padding: 2rem 1.5rem; text-align: center; cursor: pointer; transition: border-color 0.2s ease, background 0.2s ease; background: rgba(0,0,0,0.015); }',
    '.mr-up__drop:hover, .mr-up__drop.is-dragover { border-color: var(--color-accent, #00d47e); background: rgba(0,212,126,0.06); }',
    '.mr-up__drop-icon { font-size: 2rem; margin-bottom: 0.5rem; opacity: 0.7; }',
    '.mr-up__drop-title { font-weight: 600; margin-bottom: 0.25rem; color: var(--color-body, inherit); }',
    '.mr-up__drop-hint { font-size: 0.875rem; opacity: 0.7; color: var(--color-muted, inherit); }',

    '.mr-up__lib { display: flex; flex-direction: column; gap: 0.75rem; }',
    '.mr-up__lib-bar { display: flex; gap: 0.5rem; }',
    '.mr-up__lib-search { flex: 1; padding: 0.5rem 0.75rem; border-radius: 8px; border: 1px solid var(--color-border, rgba(0,0,0,0.15)); background: var(--color-bg, #fff); color: var(--color-body, inherit); font-size: 0.875rem; }',
    '.mr-up__lib-search-btn { padding: 0.5rem 1rem; border-radius: 8px; border: 0; background: var(--color-accent, #00d47e); color: #fff; cursor: pointer; font-weight: 600; font-size: 0.875rem; }',
    '.mr-up__lib-chips { display: flex; gap: 0.375rem; flex-wrap: wrap; }',
    '.mr-up__chip { padding: 0.3rem 0.7rem; border-radius: 999px; border: 1px solid var(--color-border, rgba(0,0,0,0.12)); background: transparent; cursor: pointer; font-size: 0.8125rem; color: var(--color-body, inherit); transition: background 0.18s ease, border-color 0.18s ease; }',
    '.mr-up__chip:hover { border-color: var(--color-accent, #00d47e); }',
    '.mr-up__chip.is-active { background: var(--color-accent, #00d47e); color: #fff; border-color: var(--color-accent, #00d47e); }',
    '.mr-up__lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 0.5rem; }',
    '.mr-up__lib-empty { grid-column: 1 / -1; padding: 1.5rem; text-align: center; color: var(--color-muted, rgba(0,0,0,0.5)); font-size: 0.875rem; }',
    '.mr-up__lib-tile { position: relative; aspect-ratio: 1 / 1; border-radius: 8px; overflow: hidden; border: 2px solid transparent; transition: transform 0.18s ease, border-color 0.18s ease; background: rgba(0,0,0,0.04); }',
    '.mr-up__lib-tile img { width: 100%; height: 100%; object-fit: cover; display: block; cursor: zoom-in; }',
    '.mr-up__lib-tile:hover { transform: translateY(-2px); border-color: var(--color-accent, #00d47e); }',
    '.mr-up__lib-tile.is-added { border-color: var(--color-accent, #00d47e); }',
    '.mr-up__lib-tile.is-adding { opacity: 0.6; pointer-events: none; }',
    '.mr-up__lib-icon { position: absolute; top: 0.4rem; right: 0.4rem; width: 28px; height: 28px; border-radius: 50%; border: 0; cursor: pointer; font-size: 1.05rem; line-height: 1; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; box-shadow: 0 2px 6px rgba(0,0,0,0.25); transition: background 0.18s ease, transform 0.12s ease; }',
    '.mr-up__lib-tile:not(.is-added) .mr-up__lib-icon { background: var(--color-accent, #00d47e); }',
    '.mr-up__lib-tile.is-added .mr-up__lib-icon { background: rgba(220,38,38,0.92); }',
    '.mr-up__lib-icon:hover { transform: scale(1.08); }',

    /* Expand modal */
    '.mr-up-modal { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 2rem; }',
    '.mr-up-modal__backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.78); }',
    '.mr-up-modal__panel { position: relative; max-width: 90vw; max-height: 90vh; }',
    '.mr-up-modal__panel img { max-width: 90vw; max-height: 90vh; object-fit: contain; border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,0.4); display: block; }',
    '.mr-up-modal__close { position: absolute; top: -2.4rem; right: -0.4rem; width: 36px; height: 36px; border-radius: 50%; border: 0; background: rgba(255,255,255,0.95); color: rgba(0,0,0,0.85); cursor: pointer; font-size: 1.4rem; line-height: 1; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }',

    '.mr-up__gen { display: flex; flex-direction: column; gap: 0.625rem; }',
    '.mr-up__gen-label { font-size: 0.875rem; font-weight: 600; color: var(--color-body, inherit); }',
    '.mr-up__gen-prompt { width: 100%; padding: 0.625rem 0.75rem; border-radius: 8px; border: 1px solid var(--color-border, rgba(0,0,0,0.15)); background: var(--color-bg, #fff); color: var(--color-body, inherit); font-family: inherit; font-size: 0.875rem; resize: vertical; min-height: 64px; box-sizing: border-box; }',
    '.mr-up__gen-bar { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap; }',
    '.mr-up__gen-hint { font-size: 0.78rem; color: var(--color-muted, rgba(0,0,0,0.55)); }',
    '.mr-up__gen-btn { padding: 0.5rem 1.1rem; border-radius: 8px; border: 0; background: var(--color-accent, #00d47e); color: #fff; cursor: pointer; font-weight: 600; font-size: 0.875rem; }',
    '.mr-up__draft-label { font-size: 0.8125rem; font-weight: 600; margin-top: 0.5rem; color: var(--color-body, inherit); }',
    '.mr-up__draft-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.625rem; }',
    '.mr-up__draft-tile { position: relative; aspect-ratio: 1 / 1; border-radius: 10px; overflow: hidden; background: rgba(0,0,0,0.04); border: 2px dashed rgba(0,0,0,0.15); display: flex; flex-direction: column; }',
    '.mr-up__draft-tile img { width: 100%; height: 100%; object-fit: cover; display: block; flex: 1; cursor: zoom-in; }',
    '.mr-up__draft-tile.is-loading { align-items: center; justify-content: center; background: linear-gradient(135deg, rgba(0,212,126,0.06), rgba(0,212,126,0.14)); border-color: rgba(0,212,126,0.3); }',
    '.mr-up__draft-tile.is-failed { align-items: center; justify-content: center; padding: 0.75rem; text-align: center; border-color: rgba(220,38,38,0.4); }',
    '.mr-up__draft-spin { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; color: var(--color-body, inherit); }',
    '.mr-up__draft-spin-label { font-size: 0.875rem; font-weight: 600; }',
    '.mr-up__draft-spin-sub { font-size: 0.75rem; opacity: 0.7; }',
    '.mr-up__spinner { width: 36px; height: 36px; border-radius: 50%; border: 3px solid rgba(0,212,126,0.18); border-top-color: var(--color-accent, #00d47e); animation: mr-up-spin 0.9s linear infinite; }',
    '@keyframes mr-up-spin { to { transform: rotate(360deg); } }',
    '@media (prefers-reduced-motion: reduce) { .mr-up__spinner { animation: none; border-top-color: var(--color-accent, #00d47e); opacity: 0.6; } }',
    '.mr-up__draft-fail { font-size: 0.78rem; color: rgba(220,38,38,0.85); }',
    '.mr-up__draft-fail span { font-size: 0.7rem; opacity: 0.7; }',
    '.mr-up__draft-actions { position: absolute; bottom: 0; left: 0; right: 0; display: flex; gap: 0.25rem; padding: 0.375rem; background: linear-gradient(to top, rgba(0,0,0,0.65), transparent); }',
    '.mr-up__draft-accept, .mr-up__draft-discard { flex: 1; padding: 0.4rem 0.5rem; border-radius: 6px; border: 0; cursor: pointer; font-weight: 600; font-size: 0.78rem; }',
    '.mr-up__draft-accept { background: var(--color-accent, #00d47e); color: #fff; }',
    '.mr-up__draft-discard { background: rgba(255,255,255,0.85); color: rgba(0,0,0,0.8); }',
    '.mr-up__draft-tile.is-failed .mr-up__draft-discard { position: static; margin-top: 0.5rem; align-self: center; flex: 0 0 auto; padding: 0.375rem 0.875rem; }',

    /* Single-mode collapses input area once a photo is in (headshot, logo) */
    '.mr-uploader--single.has-items .mr-up__tabs,',
    '.mr-uploader--single.has-items .mr-up__panels { display: none; }',
    '.mr-uploader--single.has-items .mr-up__grid { margin-top: 0; }',

    '.mr-up__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.625rem; }',
    '.mr-uploader--single .mr-up__grid { grid-template-columns: minmax(180px, 240px); }',
    '.mr-up__grid-empty { grid-column: 1 / -1; padding: 0.75rem 0; text-align: center; color: var(--color-muted, rgba(0,0,0,0.45)); font-size: 0.82rem; font-style: italic; }',
    '.mr-up__tile { position: relative; aspect-ratio: 1 / 1; border-radius: 10px; overflow: hidden; background: rgba(0,0,0,0.04); border: 1px solid rgba(0,0,0,0.06); }',
    '.mr-up__tile img { width: 100%; height: 100%; object-fit: cover; display: block; }',
    '.mr-up__tile.is-loading img { opacity: 0.6; filter: blur(2px); }',
    '.mr-up__tile.is-failed { border-color: rgba(220, 38, 38, 0.3); }',
    '.mr-up__no-img { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 2rem; opacity: 0.5; }',
    '.mr-up__badge { position: absolute; bottom: 0.5rem; left: 0.5rem; right: 0.5rem; text-align: center; padding: 0.25rem 0.5rem; border-radius: 6px; font-size: 0.7rem; font-weight: 600; background: rgba(0,0,0,0.7); color: #fff; }',
    '.mr-up__badge--failed { background: rgba(220, 38, 38, 0.9); }',
    '.mr-up__remove { position: absolute; top: 0.375rem; right: 0.375rem; width: 26px; height: 26px; border-radius: 50%; border: 0; background: rgba(0,0,0,0.7); color: #fff; cursor: pointer; font-size: 1.05rem; line-height: 1; display: flex; align-items: center; justify-content: center; opacity: 0.85; transition: opacity 0.18s ease, background 0.18s ease; }',
    '.mr-up__tile:hover .mr-up__remove { opacity: 1; background: rgba(220,38,38,0.9); }',
    '.mr-up__bytes { position: absolute; top: 0.5rem; left: 0.5rem; font-size: 0.7rem; color: #fff; background: rgba(0,0,0,0.55); padding: 0.125rem 0.375rem; border-radius: 4px; }',

    'body[data-theme="dark"] .mr-up__drop { background: rgba(255,255,255,0.02); border-color: rgba(255,255,255,0.18); }',
    'body[data-theme="dark"] .mr-up__drop:hover, body[data-theme="dark"] .mr-up__drop.is-dragover { background: rgba(0,212,126,0.08); }',
  ].join('\n');

  injectStyles();

  root.MRImageUploader = {
    mount: mount,
    _injectStyles: injectStyles,
  };
})(window);
