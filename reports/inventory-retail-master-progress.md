# Progress — taranom-inventory-retail-master

Order: P1→P2→P4→P6→P8→P5→P7→P9→P10→P3

| Phase | PR | Merge tip | SW | Backup | Status |
|-------|-----|-----------|-----|--------|--------|
| P0 | #110 | b48d6427 | v590 | crm.db.20261029-204228 | ✅ |
| P1 | #112 | e405bb46 | v591 | crm.db.20261101-095820 | ✅ |
| P2 | #118 | 126f919d | v592 | crm.db.20261101-103140 | ✅ |
| P4 | #116 | 71398def | v593 | crm.db.20261101-103518 | ✅ |
| P6 | #121 | a7a99dfb | v594 | crm.db.20261101-104309 | ✅ |
| P8 | #117 | 999f94a8 | v595 | crm.db.20261101-104927 | ✅ |
| P5 | #128 | 0cfa5fd3 | v596 | crm.db.20261101-105721 | ✅ |
| P7 | #125 | d6574661 | v597 | crm.db.20261101-110236 | ✅ |
| P9 | #127 | ab626f18 | v598 | crm.db.20261101-110733 | ✅ |
| P10 | #123 | ef13daec | v599 | crm.db.20261101-111514 | ✅ |
| P3 | #124 | 99663d33 | v600 | crm.db.20261101-112151 | ✅ drafts only (voucher_drafts #1..#4) — awaiting Hamed |
| P3-fix | draft PR | — | (no SW bump) | — | drafts → 110401 (v2 migration), JE1016 manual draft superseded (409 on post), reverse-preview + runbook `reports/je1016-reverse-runbook.md` — NOT merged/deployed; JE1016 reverse = Hamed only |
| FR-P3 | draft PR | — | (no SW bump) | — | drafts #2–#4 110401 → 1104 (v3 migration) + new draft openings ledger#2021–2023 (14,733,111; Dr 1104 / Cr 3102); ledger#2003 excluded; P3 drafts post on 1104 even under enforce (narrow 1104 exemption, P3 drafts only) — NOT merged/deployed |

## Gap baseline (pre-P1 deploy 2026-11-01)
- GL1104 (approved)=10,883,218,790
- kardex 34=9,874,049,856 · 35=1,123,206,997 · sum=10,997,256,853
- GL−K=−114,038,063
- leaf=warn

## Notes
- je1016-analysis.md not found on disk; using PV data report analysis for P3.
- Parallel drafts OK; merge/deploy sequential.
- P3-fix (Hamed): P3 drafts on leaf 110401; gap control on 1104 + subtree. JE1016 only via official `POST /api/accounting/subledger-recon/fixes/1/reverse` — prepared, STOP. Expected after Hamed's reverse: 1104 subtree 10,883,218,790 → 12,680,079,142; GL−K −114,038,063 → +1,682,822,289.
- FR-P3 (Hamed): whole GL inventory balance is on 1104 itself (110401 has no lines) ⇒ all P3 drafts on 1104. Openings 1230/1977/2021/2022/2023 real ⇒ Dr 1104 / Cr 3102 total 96,724,111. If all P3 drafts (#2–#4 + new) were posted: GL 1104 effect −49,611,745. P3 balance queries count only approved/posted JEs.
