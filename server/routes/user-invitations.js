const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, centralOnlyStrict } = require('../middleware/auth');
const { createInvitation } = require('../lib/user-invitations');

router.post('/invitations', auth, adminOrAccounting, centralOnlyStrict, (req, res) => {
  const personId = parseInt(req.body && req.body.person_id, 10);
  if (!Number.isFinite(personId) || personId <= 0) {
    return res.status(400).json({ error: 'شناسه شخص نامعتبر است', code: 'E_INVITE_PERSON' });
  }
  const db = getDB();
  try {
    const created = createInvitation(db, {
      personId,
      createdBy: req.user.id,
      role: req.body && req.body.role,
      actorRole: req.user.role,
    });
    audit(req.user.id, 'create', 'user_invitation', created.id, `دعوت کاربر برای شخص #${personId} نقش ${created.intended_role}`, req);
    return res.json({
      token: created.token,
      expires_at: created.expires_at,
      invite_url: created.invite_url,
      intended_role: created.intended_role,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'خطا در ساخت دعوت', code: err.code });
  }
});

module.exports = router;
