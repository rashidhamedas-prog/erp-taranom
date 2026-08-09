# Architecture

## System boundaries

- `server/`: central Node.js ERP/CRM API, web assets, SQLite data, backup and release feed.
- `android/`: Android client embedding the approved server runtime subset.
- `desktop/`: Electron client embedding the same approved runtime subset.
- `scripts/`: build, drift, deployment, backup and operational tooling.
- Windows offsite agent: pulls encrypted immutable backup packages from the VPS and performs isolated restore drills.

## Components and data flow

Clients communicate with the central API over TLS. Production runs under PM2. Generated Android/Electron runtime copies must match the source manifest verified by `scripts/compare-embedded-hash.js`. Backup packages are encrypted on the VPS, checksum-verified during a restricted pull, and restored only in an isolated drill unless explicit destructive-restore approval exists.

## Invariants and constraints

- Never commit encryption keys, signing keys, JWT secrets or provider credentials.
- Do not overwrite dirty production or local worktrees; reconcile operational files explicitly.
- Preserve PM2 encryption environment during restart; do not use `--update-env` unless all required secrets are provisioned.
- Initial release upload must verify stage hashes before atomic promotion and retain rollback.
- Full APK/EXE builds and Waves 1–4 require explicit owner direction.

## Architecture decisions

- 2026-08-08: Windows PC accepted as real off-server backup target; access is constrained by a tracked root-owned forced-command wrapper.
- 2026-08-08: Commercial Windows OV/EV certificate deferred; self-signed SmartScreen risk is documented.
- 2026-08-09: Production dependency deploy must use bounded timeout, exact version/load verification, rollback and post-restart smoke.
- 2026-08-09: `sharp@0.35.x` Linux x64 prebuilds require CPU x86-64-v2 (SSE4.2). Current Iran VPS QEMU CPU lacks `popcnt`/`sse4_*`/`ssse3`; wasm fallback also needs SSE4.1.
- 2026-08-09: Owner accepted **permanent** production waiver `W0-OPS-002-SHARP-RUNTIME-0335` (no expiry): runtime may stay on `sharp@0.33.5` while source/CI stay on `0.35.0`. Optional later path: upgrade guest CPU then `scripts/deploy-sharp-production.ps1 -Deploy`.
