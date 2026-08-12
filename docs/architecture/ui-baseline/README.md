# UI baseline — ACC-CRM-UNIFY Phase 1

Evidence captured after restoring `server/public/index.html` from healthy `448a8c1` UTF-8 and re-applying only `?v=` asset bumps.

| File | Purpose |
|------|---------|
| `phase1-login.png` | Chrome headless screenshot of live `/` login (Persian verified) |
| `phase1-login.html` | Raw HTML snapshot served by disposable server |
| `phase1-shell-admin.png` | Persian probe + CRM KPI payload after admin login |
| `phase1-crm-dashboard.png` | Same as shell probe (CRM `/api/crm/dashboard` status 200) |
| `phase1-crm-dashboard.json` | KPI JSON from authenticated CRM dashboard |

Guard: `node server/scripts/check-ui-encoding.js` (min 400 Persian chars; reject `???` runs).
