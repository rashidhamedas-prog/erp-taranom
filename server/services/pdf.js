// Server-side PDF generation via puppeteer-core + a system Chromium browser.
// One shared headless browser, jobs serialized (concurrency 1) — safe on small servers.
// Browser resolution order: PUPPETEER_EXECUTABLE_PATH env → common Linux/Windows paths.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Linux
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  // Windows (dev)
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findBrowser() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

let browserPromise = null;
let queue = Promise.resolve(); // serialize jobs

async function getBrowser() {
  if (!browserPromise) {
    const executablePath = findBrowser();
    if (!executablePath) throw new Error('مرورگر Chromium برای تولید PDF یافت نشد (PUPPETEER_EXECUTABLE_PATH را تنظیم کنید)');
    browserPromise = puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
    }).then(b => {
      b.on('disconnected', () => { browserPromise = null; });
      return b;
    }).catch(e => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

// Render an HTML string to a PDF buffer. format: 'A4' | 'A5'
async function htmlToPDF(html, { format = 'A4', landscape = false } = {}) {
  const job = queue.then(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
      // Print-media CSS (hides on-screen buttons, applies @page rules)
      await page.emulateMediaType('print');
      const data = await page.pdf({ format, landscape, printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' } });
      return Buffer.from(data); // puppeteer ≥22 returns Uint8Array — normalize for express/fs
    } finally {
      await page.close().catch(() => {});
    }
  });
  // keep the chain alive even if this job fails
  queue = job.catch(() => {});
  return job;
}

const PDF_DIR = path.join(__dirname, '..', 'public', 'uploads', 'pdfs');
fs.mkdirSync(PDF_DIR, { recursive: true });

// Render + cache to disk; returns absolute file path
async function renderToFile(html, filename, opts) {
  const buf = await htmlToPDF(html, opts);
  const filePath = path.join(PDF_DIR, filename);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

module.exports = { htmlToPDF, renderToFile, PDF_DIR, findBrowser };
