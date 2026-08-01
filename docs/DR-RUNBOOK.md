# ERP Taranom disaster recovery runbook

## Service objectives

- RPO: at most 15 minutes. The central process creates a WAL-safe SQLite snapshot every 15 minutes.
- RTO: at most 4 hours for a clean host with Node.js, repository access, secrets and object-storage credentials.
- `BACKUP_PASSWORD` must come from the secret manager/operator and must not be stored on the VPS or in Git.
- `BACKUP_S3_URI` points to an S3-compatible off-server bucket; the host needs an `aws` CLI profile through environment/instance credentials.

## Full-server recovery

1. Provision a clean host, restrict ingress, install Node.js 20 and `aws` CLI.
2. Restore environment secrets (`JWT_SECRET`, `BACKUP_PASSWORD`, S3 credentials, SMS/mail credentials).
3. Pull the approved commit; run `npm ci` in `server/`.
4. Download the newest backup and `.sha256`; verify `sha256sum -c` before decrypting.
5. Run the isolated drill/verification, then restore through the authenticated admin endpoint or `restoreBackup` maintenance command while the service is stopped.
6. Start the service; verify health, SQLite `integrity_check`, invoice/customer counts, trial balance and balance sheet.
7. Record actual RPO/RTO and the restored backup checksum in the incident log.

## Single-company / attachment recovery

- Multi-company databases are separate files. Restore the requested company DB to a temporary path first, verify its registry ID, then replace only that company's DB while writes are stopped.
- For attachments, extract `uploads/` to a temporary directory and copy only the required allowlisted subdirectory/file after comparing its checksum. Never overwrite all uploads for a single-file request.

## Weekly drill and alerting

- A weekly isolated job must download the latest off-site object, validate its checksum, decrypt/extract it outside production, run `PRAGMA integrity_check`, and compare invoice/customer counts and trial balance totals captured in the drill record.
- Alert when the latest successful off-site backup is older than 20 minutes, checksum/integrity fails, disk free space is below 20%, or a weekly drill is missing/failed.
- Production deploy remains blocked until an actual off-server restore drill is recorded within the 4-hour RTO.
