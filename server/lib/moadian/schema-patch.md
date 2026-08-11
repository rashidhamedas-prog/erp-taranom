# Moadian schema patch (ORCH)

Apply via `server/lib/moadian/schema-sql.js` — **do not edit from W1-F1 implementer**.

## Columns on `moadian_queue`

| Column | Definition | Purpose |
|--------|------------|---------|
| `retry_count` | `INTEGER DEFAULT 0` | Attempt counter for backoff |
| `next_retry_at` | `INTEGER` | Unix seconds when next retry is allowed |
| `last_error` | `TEXT` | Last adapter/API error message |
| `status_notes` | `TEXT` | JSON array of status transition notes |

## New table

`moadian_status_history` — append-only transitions (`from_status`, `to_status`, `note`).

## Index

- `idx_moadian_queue_next_retry` on `moadian_queue(next_retry_at)`
- `idx_moadian_status_history_queue` on `moadian_status_history(queue_id)`

## Status vocabulary (queue helpers)

`pending` → `sent` | `failed` | `cancelled`  
`failed` → `pending` (retry) | `cancelled`  
`sent` / `cancelled` — terminal for MVP (future: `accepted` / `rejected` from tax authority polling)
