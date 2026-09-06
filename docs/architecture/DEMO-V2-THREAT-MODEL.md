# DEMO-V2-SECURE-SALES — Threat Model

Task: `DEMO-V2-SECURE-SALES` · 2026-08-14

## Assets

- Production SQLite, uploads, backups, JWT, provider credentials
- Demo credentials (presenter accounts)
- License public/private material
- Customer PII (must never enter demo)
- Host filesystem outside demo root

## Adversaries

1. Sales-meeting visitor with UI access
2. Attendee who captures a URL / token from the projector
3. Attacker who can hit a staged demo HTTP port
4. Operator error (reset pointed at Production)
5. Accidental env leak (real SMS/SMTP keys in the same shell)

## Controls

| Threat | Control |
|--------|---------|
| Demo enabled by query/cookie | Env-only `ERP_DEMO_MODE`; ignore request signals |
| Incomplete config opens Production | Fail-closed startup; no default DB/uploads |
| Path escape via symlink/junction | `realpath` + prefix check + marker |
| Wildcard wipe of host files | Exact sidecar names; no glob delete |
| Reset of Production DB | Marker + allowlist + negative tests |
| Privilege escalation to admin | No public admin; guard blocks admin create / role change |
| Secret settings / restore / license | Demo Guard 403 + audit (no secret in log) |
| Real SMS/AI/webhook send | Egress kill-switch before any HTTP client |
| SSRF from user URL | Existing `safe-outbound-request` + demo no-op |
| XSS via brand profile | Escape text; allowlist https URLs; reject remote/SVG logo |
| Session reuse after reset | Wipe `auth-sessions.db` (+ sidecars) after swap; bump `auth_epoch` for **all** users |
| Inherited prod backup/AWS/JWT | Launch/reset scrub; boot refuses `BACKUP_S3_URI` / `BACKUP_OFFSITE_DIR`; cron skipped in demo |
| Demo bind on all interfaces | Force `LISTEN_HOST=127.0.0.1` unless `ERP_DEMO_BIND_PUBLIC=true` |
| Clock rollback / expiry bypass | `ERP_DEMO_NOW` only in tests; compare against parsed expiry |
| Hardcoded passwords in git | Generate at provision; 0600 file outside git |
| Old online script HTTP + `--update-env` | Deprecated; new launcher refuses Production process names |
| Static showcase calling APIs | Automated scan for network primitives |

## Residual risks (accepted for this task)

- Commercial license fail-open when no license is active (pre-existing; not fixed here)
- Presenter `sales_manager` can post real financial documents **inside the demo DB** (intended)
- Operator reset token, if leaked, can wipe the **demo** instance (not Production)
- Staging HTTPS is documented, not provisioned by this task
- Desktop Hub / mobile pairing remain out of scope

## Severity policy

Critical / High / Medium findings block Done. Low advisories may remain documented.
