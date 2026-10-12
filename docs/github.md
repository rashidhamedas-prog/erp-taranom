# GitHub operating model — ERP Taranom

This is the canonical GitHub architecture for `rashidhamedas-prog/erp-taranom`.
Product architecture stays in `docs/PROJECT-HANDOFF.md`.

## 1. Identity

| Item | Value |
|------|--------|
| Remote | `https://github.com/rashidhamedas-prog/erp-taranom.git` |
| Default branch | `main` |
| Production | Iran VPS `taranom@94.249.244.208` → `/home/taranom/crm-taranom` |
| Public URL | `https://erptaranom.com` |
| License | Proprietary (`LICENSE`) |

The on-disk VPS folder name `crm-taranom` is historical. Do not rename it without updating every deploy script.

## 2. Branch model

```text
origin/main                 ← GitHub default, PR target, CI
        ▲
        │  fast-forward only
feat/*  fix/*  chore/*  ai/*
```

`claude/claude-md-docs-2ssrpy` is a **legacy alias**. It must stay at the same commit as `main` until the Iran checkout is switched. Do not land unique commits only on that name.

Rules:

1. Every change starts from `origin/main`.
2. One task → one branch → one PR into `main`.
3. After merge, delete the feature branch (local and remote).
4. Do not use `tmp/*` on the remote.
5. Direct commit to `main` is not the normal path (see `.ai-dos/ai-dos.yaml`).

### Keep forever

- `main`
- `claude/claude-md-docs-2ssrpy` (until Iran `git checkout` is `main` and documented)

### Delete after merge

`ai/*`, `feat/*`, `fix/*`, `chore/*`, `cursor/*` once they are ancestors of `main`.

### Do not delete without review

- Open Dependabot branches
- Unmerged unique work (`v4-local-backup`, `revert-1-…`, unmerged `ai/*` stamps)

## 3. CI map

| Workflow | File | When |
|----------|------|------|
| CI (Wave 0 gate) | `.github/workflows/ci.yml` | push/PR to `main` |
| Production module | `.github/workflows/production-tests.yml` | path filter on production code |
| Playwright money paths | `.github/workflows/e2e.yml` | push/PR to `main` |
| Iran deploy | `.github/workflows/deploy-iran.yml` | **manual only** |

CI does **not** deploy. Node 20 in Actions is the current pin (known follow-up: runner image vs local Node 24 ABI for `better-sqlite3`).

## 4. Deploy

Forbidden on the VPS (see `docs/08-deployment.md`):

- `git reset --hard` on a dirty tree
- `pm2 restart … --update-env` unless every secret is known to be in the ecosystem file

The GitHub deploy workflow SSHs to Iran, refuses a dirty worktree, then `git pull --ff-only origin main`, `npm install --omit=dev` in `server/`, and `pm2 restart erp-taranom` **without** `--update-env`.

If the VPS is dirty (typical after SFTP overlays), use a targeted overlay instead of this workflow.

Secret: `IRAN_SSH_PRIVATE_KEY` (private key never in git).

## 5. What never goes in git

- Secrets, keystores, `.env`, JWT/backup key files
- `motefareqe/` and local design dumps
- One-shot `_deploy-*`, `_diag-*`, `_verify-*`, `_repro-*` scripts
- Word lock files `~$*`
- SQLite DB/WAL, `server/uploads/`, `server/backups/`

## 6. GitHub UI checklist (owner)

`gh` is not required for the files in this folder, but the owner should confirm:

1. Default branch = `main`
2. Branch protection on `main`: require PR, require the CI workflow, no force-push
3. Secret scanning + push protection
4. Private vulnerability reporting
5. Description: `ERP ترنم — CRM عمده + حسابداری دوطرفه (وب، ویندوز، اندروید)`
6. Topics: `erp`, `accounting`, `sqlite`, `offline-first`, `electron`, `android`
7. Disable wiki (source of truth is `docs/`)

## 7. Dual-assistant sync

Cursor and Claude Code share **git on `main`** (and the legacy alias while it exists). Unpushed work is invisible to the other assistant and to production.
