/**
 * MDI — پنجره‌های شناور شبیه ویندوز برای کل برنامه (CRM + حسابداری)
 * نوار وظایف در پایین صفحه، همیشه بالای محتوا، قابل کلیک در Chrome
 * (لایهٔ پنجره‌ها pointer-events:none + ارتفاع صفر بود و در Chrome کلیک‌ها را می‌بلعید)
 */
(function (global) {
  const STORAGE_KEY = 'crm_mdi';
  let seq = 0;
  let zTop = 200;
  const wins = new Map();
  let taskbarBound = false;
  let layerBound = false;

  function enabled() {
    try { return localStorage.getItem(STORAGE_KEY) !== '0'; } catch (_) { return true; }
  }
  function setEnabled(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (_) {}
  }

  function ensureLayer() {
    let layer = document.getElementById('mdiLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'mdiLayer';
      document.body.appendChild(layer);
    }
    let bar = document.getElementById('mdiTaskbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mdiTaskbar';
      bar.className = 'mdi-taskbar is-hidden';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'نوار پنجره‌های باز');
      const inner = document.createElement('div');
      inner.className = 'mdi-taskbar-inner';
      bar.appendChild(inner);
      document.body.appendChild(bar);
    }
    bindTaskbar(bar);
    bindLayer(layer);
    return layer;
  }

  function bindTaskbar(bar) {
    if (taskbarBound || !bar) return;
    taskbarBound = true;
    const onActivate = (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.mdi-task') : null;
      if (!btn || !bar.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      const winId = btn.getAttribute('data-win-id');
      const action = btn.getAttribute('data-mdi-action');
      if (winId) WinMgr.focus(+winId);
      else if (action === 'cascade') WinMgr.cascade();
      else if (action === 'toggle') WinMgr.toggleMode();
    };
    bar.addEventListener('click', onActivate, true);
  }

  function bindLayer(layer) {
    if (layerBound || !layer) return;
    layerBound = true;
    layer.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-mdi-cmd]') : null;
      if (!btn || !layer.contains(btn)) return;
      const winEl = btn.closest('.mdi-win');
      const id = winEl ? +winEl.dataset.winId : 0;
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      const cmd = btn.getAttribute('data-mdi-cmd');
      if (cmd === 'min') WinMgr.minimize(id);
      else if (cmd === 'max') WinMgr.toggleMax(id);
      else if (cmd === 'close') WinMgr.close(id);
    }, true);
  }

  function taskChip(title) {
    const t = String(title || '').trim();
    if (!t) return '•';
    if (t.length <= 18) return t;
    return [...t].slice(0, 16).join('') + '…';
  }

  function makeBtn(className, title, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.title = title || '';
    btn.textContent = label;
    return btn;
  }

  function updateTaskbar() {
    ensureLayer();
    const bar = document.getElementById('mdiTaskbar');
    if (!bar) return;
    let inner = bar.querySelector('.mdi-taskbar-inner');
    if (!inner) {
      inner = document.createElement('div');
      inner.className = 'mdi-taskbar-inner';
      bar.appendChild(inner);
    }
    inner.textContent = '';
    const list = [...wins.values()];
    const showBar = enabled();
    bar.classList.toggle('is-hidden', !showBar);
    if (bar.hasAttribute('hidden')) bar.removeAttribute('hidden');
    if (!showBar) { syncTaskbarSpace(); return; }

    for (const w of list) {
      const cls = ['mdi-task'];
      if (w.minimized) cls.push('min');
      if (w.id === WinMgr.focusedId) cls.push('active');
      const btn = makeBtn(cls.join(' '), w.title, taskChip(w.title));
      btn.setAttribute('data-win-id', String(w.id));
      inner.appendChild(btn);
    }
    const cascadeBtn = makeBtn('mdi-task mdi-task-tools', 'چینش پنجره‌ها', '⧉');
    cascadeBtn.setAttribute('data-mdi-action', 'cascade');
    inner.appendChild(cascadeBtn);
    const toggleBtn = makeBtn('mdi-task mdi-task-tools', 'خاموش/روشن حالت پنجره', '🗔');
    toggleBtn.setAttribute('data-mdi-action', 'toggle');
    inner.appendChild(toggleBtn);
    syncTaskbarSpace();
    requestAnimationFrame(() => { try { syncTaskbarSpace(); } catch (_) {} });
  }

  function syncTaskbarSpace() {
    const bar = document.getElementById('mdiTaskbar');
    const visible = !!(bar && !bar.classList.contains('is-hidden'));
    let h = 0;
    if (visible) {
      const rectH = bar.getBoundingClientRect().height || 0;
      h = Math.max(rectH, bar.offsetHeight || 0, 48);
    }
    document.documentElement.style.setProperty('--mdi-taskbar-h', h + 'px');
    document.body.classList.toggle('has-mdi-taskbar', visible);
  }

  if (!global.__mdiTaskbarResizeBound) {
    global.__mdiTaskbarResizeBound = true;
    window.addEventListener('resize', () => {
      try { syncTaskbarSpace(); } catch (_) {}
    });
  }

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function makeDraggable(winEl, handle) {
    let ox = 0, oy = 0, sx = 0, sy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target && e.target.closest && e.target.closest('button'))) return;
      const w = wins.get(+winEl.dataset.winId);
      if (w?.maximized) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      ox = winEl.offsetLeft; oy = winEl.offsetTop;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      WinMgr.focus(+winEl.dataset.winId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      winEl.style.left = Math.max(0, ox + (e.clientX - sx)) + 'px';
      winEl.style.top = Math.max(0, oy + (e.clientY - sy)) + 'px';
      winEl.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => { dragging = false; });
    handle.addEventListener('pointercancel', () => { dragging = false; });
  }

  function notifyFocus(w) {
    try {
      if (typeof WinMgr.onFocus === 'function') WinMgr.onFocus(w);
    } catch (_) {}
  }

  const WinMgr = {
    focusedId: null,
    enabled,
    setEnabled,
    syncTaskbarSpace,
    mount() {
      ensureLayer();
      updateTaskbar();
    },
    toggleMode() {
      const next = !enabled();
      setEnabled(next);
      if (!next) this.closeAll();
      if (typeof showToast === 'function') {
        showToast(next ? 'حالت پنجره چندگانه فعال شد' : 'حالت تک‌صفحه‌ای فعال شد');
      }
      updateTaskbar();
    },
    open(key, title, renderFn) {
      if (!enabled()) return false;
      ensureLayer();
      for (const w of wins.values()) {
        if (w.key === key) {
          this.focus(w.id);
          if (typeof renderFn === 'function') {
            Promise.resolve(renderFn(w.body)).catch((e) => {
              w.body.textContent = '';
              const err = document.createElement('div');
              err.className = 'empty';
              err.textContent = e.message || 'خطا';
              w.body.appendChild(err);
            });
          }
          return true;
        }
      }
      const id = ++seq;
      const offset = (wins.size % 8) * 28;
      const el = document.createElement('div');
      el.className = 'mdi-win mdi-maximized';
      el.dataset.winId = String(id);
      el.style.zIndex = String(++zTop);
      el.style.left = (40 + offset) + 'px';
      el.style.top = (60 + offset) + 'px';
      el.innerHTML =
        '<div class="mdi-titlebar">' +
          '<span class="mdi-title">' + escHtml(title) + '</span>' +
          '<div class="mdi-controls">' +
            '<button type="button" data-mdi-cmd="min" title="کوچک کردن">─</button>' +
            '<button type="button" class="mdi-max-btn" data-mdi-cmd="max" title="بازگرداندن از تمام‌صفحه">❐</button>' +
            '<button type="button" class="mdi-close" data-mdi-cmd="close" title="بستن">×</button>' +
          '</div>' +
        '</div>' +
        '<div class="mdi-body" id="mdiBody-' + id + '"></div>';
      document.getElementById('mdiLayer').appendChild(el);
      makeDraggable(el, el.querySelector('.mdi-titlebar'));
      el.addEventListener('pointerdown', () => this.focus(id));
      const body = el.querySelector('.mdi-body');
      const rec = { id, key, title, el, body, minimized: false, maximized: true, page: key };
      wins.set(id, rec);
      this.focus(id);
      updateTaskbar();
      if (typeof renderFn === 'function') {
        Promise.resolve(renderFn(body)).catch((e) => {
          body.textContent = '';
          const err = document.createElement('div');
          err.className = 'empty';
          err.textContent = e.message || 'خطا در بارگذاری';
          body.appendChild(err);
        });
      }
      return true;
    },
    get(id) { return wins.get(id) || null; },
    focus(id) {
      const w = wins.get(id);
      if (!w) return;
      w.minimized = false;
      w.el.classList.remove('mdi-minimized');
      w.el.style.display = '';
      w.el.style.zIndex = String(++zTop);
      this.focusedId = id;
      updateTaskbar();
      notifyFocus(w);
    },
    minimize(id) {
      const w = wins.get(id);
      if (!w) return;
      w.minimized = true;
      w.el.classList.add('mdi-minimized');
      w.el.style.display = 'none';
      if (this.focusedId === id) this.focusedId = null;
      updateTaskbar();
    },
    toggleMax(id) {
      const w = wins.get(id);
      if (!w) return;
      w.maximized = !w.maximized;
      w.el.classList.toggle('mdi-maximized', w.maximized);
      const maxBtn = w.el.querySelector('.mdi-max-btn');
      if (maxBtn) {
        maxBtn.title = w.maximized ? 'بازگرداندن از تمام‌صفحه' : 'تمام‌صفحه';
        maxBtn.textContent = w.maximized ? '❐' : '☐';
      }
      this.focus(id);
    },
    close(id) {
      const w = wins.get(id);
      if (!w) return;
      w.el.remove();
      wins.delete(id);
      if (this.focusedId === id) this.focusedId = null;
      updateTaskbar();
    },
    closeAll() {
      [...wins.keys()].forEach((id) => this.close(id));
    },
    cascade() {
      let i = 0;
      for (const w of wins.values()) {
        w.maximized = false;
        w.minimized = false;
        w.el.classList.remove('mdi-maximized', 'mdi-minimized');
        w.el.style.display = '';
        w.el.style.left = (36 + i * 28) + 'px';
        w.el.style.top = (56 + i * 28) + 'px';
        w.el.style.width = '';
        w.el.style.height = '';
        i++;
      }
      updateTaskbar();
    },
    focusedBody() {
      const w = wins.get(this.focusedId);
      return w && !w.minimized ? w.body : null;
    },
    findByKey(key) {
      for (const w of wins.values()) if (w.key === key) return w;
      return null;
    },
  };

  global.WinMgr = WinMgr;
})(window);
