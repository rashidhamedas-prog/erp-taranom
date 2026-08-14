(function (global) {
  'use strict';

  var KEYS = Object.freeze({
    state: 'erp.taranom.demo.v3.1.state',
    tour: 'erp.taranom.demo.v3.1.tour',
    theme: 'erp.taranom.demo.v3.1.theme',
    session: 'erp.taranom.demo.v3.1.session'
  });

  function storage() {
    try { return global.localStorage; } catch (e) { return null; }
  }

  function readJson(key) {
    var ls = storage();
    if (!ls) return null;
    try {
      var raw = ls.getItem(key);
      if (raw == null || raw === '') return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function writeJson(key, value) {
    var ls = storage();
    if (!ls) return;
    ls.setItem(key, JSON.stringify(value));
  }

  function loadState() { return readJson(KEYS.state); }
  function saveState(state) { writeJson(KEYS.state, state); }
  function loadTour() { return readJson(KEYS.tour); }
  function saveTour(tour) { writeJson(KEYS.tour, tour); }
  function loadTheme() {
    var o = readJson(KEYS.theme);
    return o && typeof o.value === 'string' ? o.value : (o && o.theme) || null;
  }
  function saveTheme(theme) { writeJson(KEYS.theme, { value: String(theme || 'light') }); }
  function loadSession() { return readJson(KEYS.session); }
  function saveSession(session) { writeJson(KEYS.session, session); }

  function freshState() {
    var Seed = global.DemoV3Seed;
    if (!Seed || typeof Seed.createSeed !== 'function') {
      throw new Error('DemoV3Seed missing');
    }
    return Seed.createSeed();
  }

  function getState() {
    var existing = loadState();
    if (existing && existing.meta && existing.customers) return existing;
    var fresh = freshState();
    saveState(fresh);
    return fresh;
  }

  function resetDemo() {
    var ls = storage();
    if (!ls) return;
    ls.removeItem(KEYS.state);
    ls.removeItem(KEYS.tour);
    ls.removeItem(KEYS.theme);
    ls.removeItem(KEYS.session);
  }

  var api = {
    VERSION: '3.1',
    KEYS: KEYS,
    TOAST: 'در محیط نمایشی ثبت شد؛ داده‌های اصلی شما تحت تأثیر قرار نمی‌گیرند.',
    loadState: loadState,
    saveState: saveState,
    loadTour: loadTour,
    saveTour: saveTour,
    loadTheme: loadTheme,
    saveTheme: saveTheme,
    loadSession: loadSession,
    saveSession: saveSession,
    resetDemo: resetDemo,
    freshState: freshState,
    getState: getState
  };

  global.DemoV3Store = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
