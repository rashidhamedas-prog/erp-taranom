# DEMO-V3-GUIDED-SALES — Design Note

Status: implementation design (2026-08-15)  
Task: `DEMO-V3-GUIDED-SALES`  
Base: `8a1d699`  
Branch: `feat/DEMO-V3-GUIDED-SALES`  
Worktree: `D:/soft/Claud/porje/Run in the project/erp-taranom-demo-v3`

## Product

One **static** sales-oriented showcase at `/demo.html` (same public path as V2).

Three layers:

1. Welcome / role picker (no login form first)
2. Role-based guided tour (dock, not generic tooltip-only)
3. Free ERP sandbox with linked sample data

Interactive Demo Mode (env-gated SQLite) from DEMO-V2 is **unchanged** and not required for V3.

## Files

| File | Role |
|------|------|
| `server/public/demo.html` | Welcome + app shell + CTA config |
| `server/public/demo.css` | V3 design system (replaces orange bar) |
| `server/public/demo.js` | Bootstrap / wiring only |
| `server/public/demo-v3-seed.js` | Deterministic sample graph |
| `server/public/demo-v3-store.js` | Namespaced session persistence + reset |
| `server/public/demo-v3-tour.js` | Guided tours + a11y |
| `server/public/demo-v3-app.js` | Pages, charts, interactions |
| `server/scripts/test-demo-v3.js` | Behavior + security invariants |

Reuse: `/vendor/vazirmatn`, `/vendor/chart.umd.js`, `/acc-nav.js`, `/app.css` (layout tokens).  
Do not copy `app.js`. Do not bump `sw.js` in this task.

## Isolation

- No `fetch` / XHR / WebSocket / EventSource in V3 assets
- No credentials, JWT, or Demo Mode secrets in frontend
- No production DB / uploads
- Mutations stay in memory + explicit localStorage keys
- Toast: «در محیط نمایشی ثبت شد؛ داده‌های اصلی شما تحت تأثیر قرار نمی‌گیرند.»

## Storage

Namespace version: `erp.taranom.demo.v3.1`

Explicit keys only (no prefix scan delete):

- `erp.taranom.demo.v3.1.state`
- `erp.taranom.demo.v3.1.tour`
- `erp.taranom.demo.v3.1.theme`
- `erp.taranom.demo.v3.1.session`

Reset deletes those four keys after confirm. Never touches other origins or production files.

## Sample company

- Legal/trade name: **پوشاک نمونه سپیدارگل**
- Clearly fictional; UI badge: «نسخه نمایشی» + «اطلاعات کاملاً ساختگی»
- Maker: **شرکت ترانه اندیشه پردازان ریان**
- Money: integer **تومان**; every amount labeled تومان (no ریال mix)
- Phones: `0900001xxxx` sequential, labeled نمونه

## CTA

`window.DEMO_V3_CTA = { consultUrl:'', quoteUrl:'' }`

Only `https:` URLs without credentials are followed. Empty → disabled sample buttons, no invented phone/email/address.

## Roles

| id | Title | Minutes |
|----|-------|---------|
| manager | تور مدیریتی | ۸ |
| sales | تور فروش و CRM | ۱۲ |
| accounting | تور مالی و حسابداری | ۱۰ |
| warehouse | تور انبار و تولید | ۱۰ |
| free | ورود آزاد | — |

## Visual

Direction: professional Iranian apparel ERP. Dark green / mid green / warm cream / white / limited gold. Red = alerts only. SVG icons, no nav emoji. Small corner badge instead of orange top bar. Vazirmatn. `prefers-reduced-motion`. Light/dark via `data-theme`.

## ERP capability inventory → Demo V3 mapping

Source: `server/public/acc-nav.js`, `server/public/app.js` NAV/ROUTES, `server/routes/*.js`.
Inventory agent `38705563` failed (connection); this section is the replacement.

### Real ERP surfaces (verified)

| Domain | Production evidence | Demo V3 role | Sandbox page(s) |
|--------|---------------------|--------------|-----------------|
| CRM customers / followups | `app.js` ROUTES.customers/followups; `followups.js` | sales, manager | customers, followups |
| Opportunities + pipeline | `crm.js` opportunities/stage/activities; stages lead→lost | sales, manager | opportunities |
| CRM analytics / churn / AR | `crm.js` kpis, pipeline, expert-performance, churn-risk, drilldown | manager | dash, reports |
| Invoices proforma/normal/final | `invoices.js`; acc-nav sales ops | sales, accounting | invoices |
| Settlements / receipts | acc-settlements; payments routes | sales, accounting | receipts |
| Cheques lifecycle | `acc-cheques-*`; trust-checks | accounting, manager | cheques |
| Parties / receivables / statement | acc-parties, acc-receivables, acc-statement | accounting | parties, ledger |
| Journals / COA / trial / P&L | acc-journal-*, acc-trial-balance, acc-pl-statement | accounting | journals, trial, pnl |
| Banks / cash / transfers | acc-banks, acc-cash-boxes, acc-account-transfer | accounting | banks |
| Products + color/size SKU | acc-products, product-variants | warehouse, sales | products |
| Warehouses / kardex / landed | warehouses.js, inventory.js, acc-item-kardex | warehouse | stock, warehouses |
| BOM / production orders / cost | production-boms.js, production-orders.js | warehouse | boms, production |
| B2B portal orders | portal.js; demo NAV b2bOrders | sales, free | b2b |
| Alerts / reminders | notifications.js, reminders.js | manager | alerts |
| Payroll / fixed assets / Moadian / 2FA / backup / devices | dedicated routes + acc-nav | **out of guided tours** | free-nav tables only, no fake tax filing |

### Current Demo V2 gaps (must close)

- Login card first; no welcome / role picker / CTA
- 12 customers, 12 products, 12 followups, 48 invoices, 6 months
- `readOnly()` toast: «ذخیره روی سرور انجام نمی‌شود»
- Orange full-width watermark (`#92400e`, `padding-top:32px`)
- Nav emoji; many `acc-*` pages fall through to placeholder
- No opportunities, BOM, linked JE, 12-month story, or guided tour
- No reset namespace; no sales CTA config

### Non-goals (do not simulate as live integrations)

Moadian submit, SMS provider, license activate, backup download, device pairing, production DB, file upload, real bank recon network.

## ERP inventory → Demo V3 mapping

Source: `server/public/acc-nav.js`, `server/public/app.js` NAV/ROUTES, `server/routes/*.js`.
Inventory agent `38705563` failed (connection); this section is the replacement.

### Real product surfaces (verified)

| Domain | Production evidence | Demo V3 role | Sandbox page / tour |
|--------|---------------------|--------------|---------------------|
| CRM customers / followups | `app.js` ROUTES.customers/followups; `followups.js` | sales, manager | customers, followups |
| CRM opportunities + analytics | `crm.js` opportunities/pipeline/kpis/churn/drilldown | sales, manager | opportunities, dash |
| Invoices proforma/normal/final | `invoices.js`; acc-nav فروش | sales, accounting | invoices |
| Products + color/size SKU | `products.js`, `product-variants.js` | warehouse, sales | products, stock |
| Warehouses / kardex / landed | `warehouses.js`, `inventory.js` | warehouse | stock, warehouses |
| Production BOM / orders / MRP | `production-boms.js`, `production-orders.js` | warehouse | boms, production |
| Journal / COA / trial / P&L | acc-nav حسابداری; accounting routes | accounting, manager | journals, trial, pnl |
| Bank / cash / cheques | acc-nav بانک و چک | accounting | banks, cheques, receipts |
| B2B portal orders | `portal.js`, demo NAV b2bOrders | sales, free | b2b |
| Payroll / fixed assets / Moadian | acc-nav حقوق، دارایی، مودیان | free (table, not tour-critical) | acc-* real tables |
| Settings / backup / devices / 2FA | central-only | **out of demo mutations** | help note only |

### Current `/demo.html` gaps (V2 static)

- Login card first; no welcome / role picker / CTA
- 12 customers, 12 products, 12 followups, 48 invoices, 6 months
- `readOnly()` toast: «ذخیره روی سرور انجام نمی‌شود»
- Orange full-width `.demo-watermark` (`#92400e`)
- Nav emoji; many `acc-*` pages fall through to placeholder
- No opportunities, BOM, 12-month story, linked JE, guided tour
- No reset namespace, no sales CTA config

### Non-goals (do not fake as live integrations)

- Moadian network, SMS provider, license activate, backup download
- Production auth / public admin / hardcoded passwords
- Copy of entire `app.js`

## Rollback

- Before merge: abandon `feat/DEMO-V3-GUIDED-SALES` / remove worktree
- After merge (not this task): revert merge commit
- Runtime: V3 is static files only; production app/auth untouched
