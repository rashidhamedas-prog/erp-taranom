'use strict';

const fs = require('fs');
const path = require('path');
const { getDemoState } = require('./demo-mode');

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PHONE = /^[0-9+\-() ]{6,20}$/;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const MAX_TEXT = 80;
const MAX_LOGO_BYTES = 256 * 1024;
const ALLOWED_LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

function escapeText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clip(s, n = MAX_TEXT) {
  return String(s || '').trim().slice(0, n);
}

function validateHttpsUrl(raw, { allowPath = true } = {}) {
  if (!raw) return null;
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!allowPath && u.pathname !== '/' && u.pathname !== '') return null;
  return u.toString();
}

function looksLikeSvg(buf) {
  const head = buf.slice(0, 256).toString('utf8').toLowerCase();
  return head.includes('<svg') || head.includes('<?xml');
}

function validateLogoFile(filePath) {
  if (!filePath) return { ok: false, reason: 'missing' };
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return { ok: false, reason: 'missing' };
  const st = fs.statSync(abs);
  if (!st.isFile() || st.size <= 0 || st.size > MAX_LOGO_BYTES) {
    return { ok: false, reason: 'size' };
  }
  const buf = fs.readFileSync(abs);
  if (looksLikeSvg(buf)) return { ok: false, reason: 'svg_forbidden' };
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  const webp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf.slice(8, 12).toString('ascii') === 'WEBP';
  if (!png && !jpg && !webp) return { ok: false, reason: 'signature' };
  return { ok: true, mime: png ? 'image/png' : jpg ? 'image/jpeg' : 'image/webp' };
}

function defaultBrand() {
  return {
    brand_name: 'ERP ترنم',
    legal_name: 'پوشاک ترنم (نمونه نمایشی)',
    short_name: 'ترنم',
    logo_url: '/logo-sm.png',
    favicon: '/logo-sm.png',
    primary_color: '#1A5C38',
    secondary_color: '#C9A227',
    support_phone: '',
    support_email: '',
    sales_url: null,
    demo_watermark: 'نسخه نمایشی — داده‌ها واقعی نیستند',
    powered_by_visible: true,
  };
}

function loadBrandProfile() {
  const base = defaultBrand();
  const state = getDemoState();
  if (!state.enabled) return { ...base, sales_url: null };
  const file = path.join(state.root, 'brand.json');
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
    } catch {
      raw = {};
    }
  }
  const brand = { ...base };
  brand.brand_name = clip(raw.brand_name || base.brand_name);
  brand.legal_name = clip(raw.legal_name || base.legal_name);
  brand.short_name = clip(raw.short_name || base.short_name, 24);
  brand.primary_color = HEX.test(String(raw.primary_color || '')) ? raw.primary_color : base.primary_color;
  brand.secondary_color = HEX.test(String(raw.secondary_color || '')) ? raw.secondary_color : base.secondary_color;
  const phone = clip(raw.support_phone || '', 20);
  brand.support_phone = PHONE.test(phone) ? phone : '';
  const email = clip(raw.support_email || '', 80);
  brand.support_email = EMAIL.test(email) ? email : '';
  brand.sales_url = validateHttpsUrl(raw.sales_url || state.salesUrl) || state.salesUrl;
  brand.demo_watermark = clip(raw.demo_watermark || base.demo_watermark, 120);
  brand.powered_by_visible = raw.powered_by_visible !== false;
  const logoRaw = String(raw.logo_url || base.logo_url);
  if (logoRaw.startsWith('/') && !logoRaw.startsWith('//') && !logoRaw.includes('..')) {
    brand.logo_url = logoRaw;
  } else {
    brand.logo_url = base.logo_url;
  }
  const fav = String(raw.favicon || brand.logo_url);
  brand.favicon = (fav.startsWith('/') && !fav.startsWith('//') && !fav.includes('..')) ? fav : brand.logo_url;
  return {
    ...brand,
    brand_name_safe: escapeText(brand.brand_name),
    legal_name_safe: escapeText(brand.legal_name),
    watermark_safe: escapeText(brand.demo_watermark),
  };
}

module.exports = {
  ALLOWED_LOGO_MIME,
  defaultBrand,
  escapeText,
  loadBrandProfile,
  validateHttpsUrl,
  validateLogoFile,
};
