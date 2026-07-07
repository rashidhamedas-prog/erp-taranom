// Copies the shared backend (../server) into desktop/server so the desktop
// package is self-contained. node_modules is excluded — the desktop app's own
// package.json lists the same dependencies, and electron-builder rebuilds the
// native ones (better-sqlite3, sharp) against Electron's ABI at package time.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'server');
const DST = path.join(__dirname, '..', 'server');

const EXCLUDE = new Set(['node_modules', 'backups']);
const EXCLUDE_FILE = /\.db(-wal|-shm)?$|^\.env$/;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    if (entry.isFile() && EXCLUDE_FILE.test(entry.name)) continue;
    // uploaded user content stays on each machine — don't bake it into the app
    if (src.endsWith(path.join('public')) && entry.name === 'uploads') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(DST, { recursive: true, force: true });
copyDir(SRC, DST);
console.log('✅ server sources copied into desktop/server');
