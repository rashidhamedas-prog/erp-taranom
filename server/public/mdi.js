/**
 * MDI — پنجره‌های شناور شبیه ویندوز برای زیرمنوهای حسابداری / CRM
 * هر زیرگروه می‌تواند در پنجره جدا باز شود؛ کنترل: جابجایی، کوچک/بزرگ، بستن، نوار وظیفه
 */
(function (global) {
  const STORAGE_KEY = 'crm_mdi';
  let seq = 0;
  let zTop = 200;
  const wins = new Map();

  function enabled() {
    try { return localStorage.getItem(STORAGE_KEY) !== '0'; } catch (_) { return true; }
  }
  function setEnabled(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (_) {}
  }

  function ensureLayer() {
    let layer = document.getElementById('mdiLayer');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'mdiLayer';
    layer.innerHTML = '<div id="mdiTaskbar" class="mdi-taskbar" hidden></div>';
    document.body.appendChild(layer);
    return layer;
  }

  function updateTaskbar() {
    const bar = document.getElementById('mdiTaskbar');
    if (!bar) return;
    const list = [...wins.values()];
    if (!list.length) { bar.hidden = true; bar.innerHTML = ''; syncTaskbarSpace(); return; }
    bar.hidden = false;
    bar.innerHTML = list.map((w) =>
      `<button type="button" class="mdi-task ${w.minimized ? 'min' : ''} ${w.id === WinMgr.focusedId ? 'active' : ''}" onclick="WinMgr.focus(${w.id})" title="${escAttr(w.title)}">${escHtml(w.title)}</button>`
    ).join('') +
      `<button type="button" class="mdi-task mdi-task-tools" onclick="WinMgr.cascade()" title="چینش پنجره‌ها">⧉</button>` +
      `<button type="button" class="mdi-task mdi-task-tools" onclick="WinMgr.toggleMode()" title="خاموش/روشن حالت پنجره">${enabled() ? '🗔' : '📄'}</button>`;
    syncTaskbarSpace();
    requestAnimationFrame(syncTaskbarSpace);
  }

  /** ارتفاع واقعی نوار پایین را به CSS می‌دهد تا پنجره‌ها/مودال‌ها زیر آن نروند */
  function syncTaskbarSpace() {
    const bar = document.getElementById('mdiTaskbar');
    const h = (bar && !bar.hidden) ? Math.ceil(bar.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty('--mdi-taskbar-h', h + 'px');
    document.body.classList.toggle('has-mdi-taskbar', h > 0);
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
  function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

  function makeDraggable(winEl, handle) {
    let ox = 0, oy = 0, sx = 0, sy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const w = wins.get(+winEl.dataset.winId);
      if (w?.maximized) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      ox = winEl.offsetLeft; oy = winEl.offsetTop;
      WinMgr.focus(+winEl.dataset.winId);
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      winEl.style.left = Math.max(0, ox + (e.clientX - sx)) + 'px';
      winEl.style.top = Math.max(0, oy + (e.clientY - sy)) + 'px';
      winEl.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  const WinMgr = {
    focusedId: null,
    enabled,
    setEnabled,
    toggleMode() {
      setEnabled(!enabled());
      if (typeof showToast === 'function') {
        showToast(enabled() ? 'حالت پنجره چندگانه فعال شد' : 'حالت تک‌صفحه‌ای فعال شد');
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
              w.body.innerHTML = `<div class="empty">${escHtml(e.message || 'خطا')}</div>`;
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
      el.innerHTML = `
        <div class="mdi-titlebar">
          <span class="mdi-title">${escHtml(title)}</span>
          <div class="mdi-controls">
            <button type="button" title="کوچک کردن" onclick="WinMgr.minimize(${id})">─</button>
            <button type="button" class="mdi-max-btn" title="بازگرداندن از تمام‌صفحه" onclick="WinMgr.toggleMax(${id})">❐</button>
            <button type="button" class="mdi-close" title="بستن" onclick="WinMgr.close(${id})">×</button>
          </div>
        </div>
        <div class="mdi-body" id="mdiBody-${id}"><div class="muted" style="padding:16px">در حال بارگذاری...</div></div>`;
      document.getElementById('mdiLayer').appendChild(el);
      makeDraggable(el, el.querySelector('.mdi-titlebar'));
      el.addEventListener('mousedown', () => this.focus(id));
      const body = el.querySelector('.mdi-body');
      const rec = { id, key, title, el, body, minimized: false, maximized: true, page: key };
      wins.set(id, rec);
      this.focus(id);
      updateTaskbar();
      if (typeof renderFn === 'function') {
        Promise.resolve(renderFn(body)).catch((e) => {
          body.innerHTML = `<div class="empty" style="padding:16px">${escHtml(e.message || 'خطا در بارگذاری')}</div>`;
        });
      }
      return true;
    },
    focus(id) {
      const w = wins.get(id);
      if (!w) return;
      w.minimized = false;
      w.el.classList.remove('mdi-minimized');
      w.el.style.display = '';
      w.el.style.zIndex = String(++zTop);
      this.focusedId = id;
      updateTaskbar();
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
