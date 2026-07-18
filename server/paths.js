const path = require('path');

// Root directory for user-uploaded files (product images, voucher
// attachments, message media). Defaults to public/uploads inside the app —
// device builds (Electron/Android) override it via UPLOADS_DIR because the
// install directory isn't writable there; the /uploads static mount in
// server.js serves whichever root is active.
const UPLOADS_ROOT = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');

module.exports = { UPLOADS_ROOT };
