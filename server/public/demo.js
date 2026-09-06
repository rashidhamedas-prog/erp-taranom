'use strict';

function escCta(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function isHttpsUrl(raw) {
  try {
    var u = new URL(String(raw || '').trim());
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch (e) {
    return false;
  }
}

function applyCta(anchor, url, label) {
  if (!anchor) return;
  if (isHttpsUrl(url)) {
    anchor.href = new URL(String(url).trim()).toString();
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.classList.remove('is-disabled');
    anchor.removeAttribute('aria-disabled');
    if (label) anchor.textContent = label;
  } else {
    anchor.removeAttribute('href');
    anchor.classList.add('is-disabled');
    anchor.setAttribute('aria-disabled', 'true');
  }
}

function wireCtas() {
  var cfg = window.DEMO_V3_CTA || {};
  applyCta(document.getElementById('ctaConsult'), cfg.consultUrl, cfg.consultLabel);
  applyCta(document.getElementById('ctaQuote'), cfg.quoteUrl, cfg.quoteLabel);
  applyCta(document.getElementById('summaryConsult'), cfg.consultUrl, 'درخواست جلسه');
  applyCta(document.getElementById('summaryQuote'), cfg.quoteUrl, 'درخواست قیمت');
  var note = document.getElementById('ctaSampleNote');
  if (note) note.hidden = !!(isHttpsUrl(cfg.consultUrl) || isHttpsUrl(cfg.quoteUrl));
}

function setTheme(theme) {
  var next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  if (window.DemoV3Store) DemoV3Store.saveTheme(next);
  var label = next === 'dark' ? 'حالت روشن' : 'حالت تاریک';
  ['welcomeThemeBtn', 'acctThemeBtn'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.textContent = label;
  });
}

function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  setTheme(cur);
}

function showApp() {
  var welcome = document.getElementById('welcome');
  var app = document.getElementById('app');
  if (welcome) welcome.hidden = true;
  if (app) { app.hidden = false; app.removeAttribute('hidden'); }
}

function showWelcome() {
  var welcome = document.getElementById('welcome');
  var app = document.getElementById('app');
  var summary = document.getElementById('summary');
  if (welcome) welcome.hidden = false;
  if (app) app.hidden = true;
  if (summary) summary.hidden = true;
  if (window.DemoV3Tour) DemoV3Tour.stop();
}

function enterRole(role) {
  showApp();
  if (window.DemoV3App) DemoV3App.init();
  if (role === 'free') DemoV3App.enterFree();
  else {
    DemoV3App.go('dash');
    DemoV3Tour.start(role);
  }
  if (window.DemoV3Store) DemoV3Store.saveSession({ role: role, at: Date.now() });
}

function enterAccountingShell() {
  if (window.DemoV3App) DemoV3App.enterAccountingShell();
}

function renderAccPage(page) {
  if (window.DemoV3App) DemoV3App.renderAccPage(page);
}

function go(page) {
  if (window.DemoV3App) DemoV3App.go(page);
}

function tickClock() {
  var c = document.getElementById('clock');
  if (!c) return;
  c.textContent = new Date().toLocaleString('fa-IR', { hour: '2-digit', minute: '2-digit' });
}

function toggleSecurity(open) {
  var pop = document.getElementById('demoSecurityPop');
  var btn = document.getElementById('demoSecurityBtn');
  if (!pop || !btn) return;
  var show = open == null ? pop.hidden : open;
  pop.hidden = !show;
  btn.setAttribute('aria-expanded', show ? 'true' : 'false');
}

function bindShell() {
  document.querySelectorAll('[data-start]').forEach(function (btn) {
    btn.addEventListener('click', function () { enterRole(btn.getAttribute('data-start')); });
  });
  var wt = document.getElementById('welcomeThemeBtn');
  if (wt) wt.addEventListener('click', toggleTheme);
  var at = document.getElementById('acctThemeBtn');
  if (at) at.addEventListener('click', toggleTheme);
  var out = document.getElementById('acctBtnOut');
  if (out) out.addEventListener('click', showWelcome);
  var backW = document.getElementById('acctWelcomeBtn');
  if (backW) backW.addEventListener('click', showWelcome);
  var fab = document.getElementById('acctFab');
  var drawer = document.getElementById('acctDrawer');
  var backdrop = document.getElementById('acctDrawerBackdrop');
  function closeDrawer() {
    if (fab) { fab.classList.remove('open'); fab.setAttribute('aria-expanded', 'false'); }
    if (drawer) drawer.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
  }
  if (fab) fab.addEventListener('click', function () {
    var open = drawer && drawer.classList.contains('open');
    if (open) closeDrawer();
    else {
      fab.classList.add('open');
      fab.setAttribute('aria-expanded', 'true');
      if (drawer) drawer.classList.add('open');
      if (backdrop) backdrop.classList.add('open');
    }
  });
  if (backdrop) backdrop.addEventListener('click', closeDrawer);
  var menu = document.getElementById('menuBtn');
  var side = document.getElementById('sidebar');
  var sb = document.getElementById('sidebarBackdrop');
  if (menu) menu.addEventListener('click', function () {
    if (side) side.classList.toggle('open');
    if (sb) sb.classList.toggle('show');
  });
  if (sb) sb.addEventListener('click', function () {
    if (side) side.classList.remove('open');
    sb.classList.remove('show');
  });
  var back = document.getElementById('navBackBtn');
  if (back) back.addEventListener('click', function () { if (window.DemoV3App) DemoV3App.back(); });
  var nav = document.getElementById('nav');
  if (nav) nav.addEventListener('click', function (e) {
    var head = e.target.closest('[data-acc-sec]');
    if (head && typeof ACC_NAV_SECTIONS !== 'undefined') {
      e.preventDefault();
      if (window.DemoV3App && typeof DemoV3App.toggleAccSection === 'function') {
        DemoV3App.toggleAccSection(Number(head.getAttribute('data-acc-sec')));
      }
      return;
    }
    var a = e.target.closest('a[data-page]');
    if (!a) return;
    e.preventDefault();
    go(a.getAttribute('data-page'));
    if (side) side.classList.remove('open');
    if (sb) sb.classList.remove('show');
  });
  var reset = document.getElementById('resetDemoBtn');
  if (reset) reset.addEventListener('click', function () { DemoV3App.confirmReset(); });
  var bell = document.getElementById('notifBell');
  if (bell) bell.addEventListener('click', function () { go('alerts'); });
  var secBtn = document.getElementById('demoSecurityBtn');
  var secClose = document.getElementById('demoSecurityClose');
  if (secBtn) secBtn.addEventListener('click', function () { toggleSecurity(); });
  if (secClose) secClose.addEventListener('click', function () { toggleSecurity(false); });
  var sumFree = document.getElementById('summaryFree');
  var sumOther = document.getElementById('summaryOther');
  if (sumFree) sumFree.addEventListener('click', function () {
    if (window.DemoV3App) DemoV3App.hideSummary();
    DemoV3Tour.goFree();
  });
  if (sumOther) sumOther.addEventListener('click', function () {
    if (window.DemoV3App) DemoV3App.hideSummary();
    showWelcome();
  });
  tickClock();
  setInterval(tickClock, 30000);
}

function boot() {
  wireCtas();
  var savedTheme = window.DemoV3Store && DemoV3Store.loadTheme();
  setTheme(savedTheme || 'light');
  DemoV3App.init();
  DemoV3Tour.bind();
  bindShell();
  var session = window.DemoV3Store && DemoV3Store.loadSession();
  var restored = DemoV3Tour.restore();
  if (restored) showApp();
  else if (session && session.role === 'free') {
    showApp();
    DemoV3App.enterFree();
  } else {
    showWelcome();
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
