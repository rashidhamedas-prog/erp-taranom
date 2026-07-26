# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ MANDATORY RULE: Keep the in-app Help updated

After **every** change (minor or major) to features or behavior, you MUST update the in-app Help/Guide section (`ROUTES.help` → `renderAdminGuide()` / `renderSalesGuide()` in `server/public/index.html`) in the same commit. A feature change without a matching Help update is an incomplete change.

Also append an entry to **`docs/CHANGE-LOG.md`** (date, commit hash, summary, key files, deploy status) so future Claude Code sessions know what was already applied.

## ⚠️ MANDATORY RULE: Coordination with Cursor (dual-assistant workflow)

This project is developed by **two assistants in parallel**: Cursor (on the user's Windows machine, working folder `D:\soft\claud\porje\CursorCrm\erp-taranom`) and Claude Code (remote, git-only). Git on branch `claude/claude-md-docs-2ssrpy` is the ONLY shared channel — neither assistant can see the other's uncommitted work.

Therefore, after **every** task (even docs-only or no-op sessions worth recording):

1. **Read `docs/CHANGE-LOG.md` first** before starting any work — the other assistant may have already done it or changed the surrounding code.
2. **Append an entry** at the top of the تاریخچه section (format is defined at the top of that file) describing what was done, key files, and deploy status — written so the other assistant is fully briefed without reading the diff.
3. **Commit and push** to `claude/claude-md-docs-2ssrpy` in the same session. An unpushed change is invisible to the other assistant and to production.
4. Before large or overlapping work, `git fetch` and rebase/align to `origin/claude/claude-md-docs-2ssrpy` to avoid collisions.

## Project Overview

ERP ترنم (ERP Taranom) is a wholesale customer management + full accounting system for a women's clothing manufacturer ("پوشاک ترنم", based in Mashhad).

## Current Architecture (v3 — authoritative; sections further below describe the legacy v1 prototype)

- **Backend**: Node.js/Express + better-sqlite3, in `server/`. Entry: `server/server.js`; schema+migrations are code-embedded in `server/db.js` (`initDB()` + `ensureColumn()` — idempotent on every boot, no separate migration files).
- **Frontend**: single file `server/public/index.html` (CSS+HTML+JS), served by the same Express app; talks to `/api/*` with relative fetches only.
- **Accounting**: double-entry (journal_entries/journal_lines + chart_of_accounts) with customer/supplier/person sub-ledgers posting to control accounts (1103/2101/1106). Invoice/PO numbers come from the atomic `number_sequences` table — never COUNT(*)+1.
- **Offline-first devices + sync** (see `docs/OFFLINE-SYNC.md`): the same server runs embedded in the Windows app (`desktop/`, Electron) and Android app (`android/`, nodejs-mobile) with `SYNC_ROLE=device`. Sync is operation-replay: devices record successful mutating API calls in `sync_outbox` (capture middleware) and central re-executes them through its real route handlers via loopback HTTP; pull is incremental via trigger-stamped `sync_seq` + tombstones. Device-created rows use a reserved high id range per device (`sync/tables.js` — its table array is APPEND-ONLY). Conflicts are flagged for human review, never silently applied.
- **Central-only surfaces** (403 on device builds via `centralOnly` middleware): settings, user management, API keys, backups, SMS/cron, `PATCH /products/:id/stock`, accounting backfill.
- **Tests**: `node server/scripts/test-sms.js` (22 assertions) and `node server/scripts/test-sync.js` (25-assertion end-to-end central+2-devices harness). Run both after backend changes. Frontend check: extract the `<script>` block from index.html and `new Function(it)`.
- **Env flags**: `SYNC_ROLE=central|device`, `DB_PATH`, `UPLOADS_DIR`, `PORT`, `JWT_SECRET`, `SYNC_INTERVAL_MS`.
- Multi-statement business operations must run inside `db.transaction()`; the ledger/journal helpers rethrow inside transactions so failures roll back atomically.

The sections below describe the original single-file prototype and are kept for history — the production system is the `server/` app above.

The original prototype lived in a **single file**: `index.html` at the repo root. There is no build process, package manager, or test suite for it — edit the file and open it in a browser.

## Running the App

Open `index.html` directly in a browser, or serve it via any static file server:

```bash
# Python
python3 -m http.server 8080

# Node (npx)
npx serve .
```

No compilation step. No dependencies to install.

## Architecture

The file is structured in three contiguous sections:

1. **CSS** (`<style>` block, lines ~11–191) — All styling using CSS custom properties (`--purple`, `--green`, etc.) defined in `:root`.
2. **HTML** (lines ~192–567) — Five tab pages (`dash`, `customers`, `orders`, `followups`, `invoices`) plus five modals (customer, order, followup, invoice, viewinv) and a confirm-delete dialog.
3. **JavaScript** (`<script>` block, lines ~568–1319) — All logic: Firebase init, CRUD operations, render functions, and UI helpers.

### Data Layer: Firebase + LocalStorage Fallback

- **Firebase Firestore** (compat SDK v10.7.1) is the primary store. Credentials are hardcoded in `FB_CONFIG` (lines ~572–581). Real-time `onSnapshot` listeners keep the four in-memory arrays (`customers`, `orders`, `followups`, `invoices`) synced.
- If Firebase fails to init, `USE_FIREBASE` stays `false` and the app operates in offline mode, persisting to `localStorage` under keys `crm_c`, `crm_o`, `crm_f`, `crm_i`.
- The sync indicator dot (`#syncDot`) is green when Firebase is connected, amber when offline.

### In-Memory State

Four global arrays are the single source of truth at runtime:
- `customers` — business name, owner, city, phone, Instagram, type, status
- `orders` — linked to `custId`, includes quantities, totals, paid amounts, delivery dates
- `followups` — linked to `custId`, tracks contact type, subject, priority, next follow-up date
- `invoices` — linked to `custId`, line-item rows with per-item pricing, discount percentage, totals

### Key Conventions

- **Customer statuses**: `vip`, `active`, `followup`, `silent`, `new`
- **Order statuses**: `pending`, `onway`, `done`, `cancel`
- **Followup statuses**: `open`, `done`, `cancel`; priorities: `high`, `mid`, `low`
- **Invoice types**: `proforma` (پیش‌فاکتور), `final` (فاکتور رسمی); numbered as `T-0001`, `T-0002`, …
- **IDs**: Generated with `uid(prefix)` → `prefix + '-' + Date.now().toString(36)` in offline mode; Firestore auto-IDs when online.
- **Dates**: Persian (Jalali) calendar strings entered manually by the user (e.g. `1403/04/01`). No date parsing library is used.
- **Currency**: All amounts in Iranian Toman. Displayed with `fmt(n)` which calls `Number.toLocaleString('fa-IR')`.

### UI Patterns

- Tab switching: `showPage(p)` toggles `.active` on both `.tab` and `.page` elements.
- Modals: `openModal(type)` / `closeModal(type)` toggle the `.open` class on `.overlay` elements. Backdrop click closes the modal.
- CRUD flow: form fields use IDs prefixed by entity abbreviation (`c-` for customer, `o-` for order, `f-` for followup, `inv-` for invoice). A hidden `<input type="hidden">` with the entity's `id` field distinguishes create vs. update.
- `renderAll()` calls all four render functions and conditionally calls `renderDash()`.
- The monthly sales chart uses Chart.js 4.4.1 (CDN). The chart instance is stored in `mChart`; it must be destroyed (`mChart.destroy()`) before recreating to avoid canvas conflicts.
- Invoice print: `window.print()` on the view-invoice modal; CSS `@media print` hides all nav chrome and renders only the invoice preview.
- Font: Vazirmatn (Google Fonts CDN) for Persian text.

## Firebase Collections

| Collection  | Key fields |
|-------------|-----------|
| `customers` | `biz`, `owner`, `city`, `phone`, `insta`, `type`, `status`, `note`, `createdAt` |
| `orders`    | `custId`, `date`, `type`, `qty`, `total`, `paid`, `pay`, `deliver`, `status`, `note`, `createdAt` |
| `followups` | `custId`, `date`, `type`, `subject`, `note`, `action`, `next`, `status`, `priority`, `createdAt` |
| `invoices`  | `custId`, `type`, `date`, `note`, `rows[]`, `subtotal`, `disc`, `discAmt`, `final`, `num`, `createdAt` |

All collections are ordered by `createdAt desc` in their Firestore queries.

## Production Server

- **IP**: `45.90.98.99`
- **SSH port**: `2299`
- **User**: `taranom-admin`
- **SSH key** (client-side, never commit): `C:\Users\DayaTech\.ssh\taranom_server`
- **App path**: `/home/taranom-admin/crm-taranom`
- **Process manager**: PM2, process name `erp-taranom`
- **Branch**: `claude/claude-md-docs-2ssrpy`

Connect:
```bash
ssh -p 2299 -i C:\Users\DayaTech\.ssh\taranom_server taranom-admin@45.90.98.99
```

Deploy command (run on server):
```bash
cd /home/taranom-admin/crm-taranom && git pull origin claude/claude-md-docs-2ssrpy && cd server && npm install && pm2 restart erp-taranom
```

**Android APK policy:** build locally with `scripts/build-android.ps1` only. Never `scp` APK to production `/releases/`. Sideload to devices via USB or direct file transfer.
