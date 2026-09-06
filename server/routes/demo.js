'use strict';

const express = require('express');
const crypto = require('crypto');
const { publicDemoStatus, getDemoState, isDemoMode } = require('../lib/demo-mode');
const { loadBrandProfile } = require('../lib/demo-brand');
const { clientAllowed, normalizeResetClientIp } = require('../lib/demo-reset');

const router = express.Router();

router.get('/status', (req, res) => {
  const status = publicDemoStatus();
  if (!status.demo) return res.json({ demo: false });
  const brand = loadBrandProfile();
  return res.json({
    ...status,
    brand: {
      brand_name: brand.brand_name,
      short_name: brand.short_name,
      logo_url: brand.logo_url,
      favicon: brand.favicon,
      primary_color: brand.primary_color,
      secondary_color: brand.secondary_color,
      sales_url: brand.sales_url,
      demo_watermark: brand.demo_watermark,
      powered_by_visible: brand.powered_by_visible,
    },
  });
});

function resetTokenOk(req) {
  const expected = String(process.env.ERP_DEMO_RESET_TOKEN || '');
  if (expected.length < 32) return false;
  const got = String(req.get('x-demo-reset-token') || '');
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

router.post('/operator/reset', (req, res) => {
  if (!isDemoMode()) {
    return res.status(404).json({ error: 'not found' });
  }
  if (!resetTokenOk(req) || !clientAllowed(req)) {
    return res.status(403).json({ error: 'reset forbidden', code: 'demo_operation_blocked' });
  }
  return res.status(202).json({
    ok: true,
    accepted: true,
    message: 'Reset must be executed by the operator CLI (scripts/demo-v2/reset.js). API only acknowledges a valid operator token.',
  });
});

router.get('/config', (req, res) => {
  return res.status(403).json({ error: 'این عملیات در نسخه نمایشی مجاز نیست', code: 'demo_operation_blocked' });
});

module.exports = router;
module.exports.clientAllowed = clientAllowed;
module.exports.normalizeResetClientIp = normalizeResetClientIp;
void getDemoState;
