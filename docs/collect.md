# DISHA Collect

VM-only workflow: **admin, region and division officers** request structured reports from subordinate offices. Assignees share **one draft per office** (last-writer stamp). After the due time the form locks; the requester may **extend** the deadline — saves in that window are stamped **`late`**.

Not available on Vercel (needs PocketBase). Local checkouts without `PB_URL` + superuser get `503` / `available: false`.

| Where | What |
|---|---|
| `lib/collect.js` | PocketBase client, scope rules, `/api/collect/*` |
| `collect/index.html` | Inbox, create request (P0), extend, countdown chips |
| `vm/pocketbase/pb_migrations/1794300000_app_collect.js` | Collections below |
| Shell | Top-bar pill + sidebar badge when `pending_count > 0`; Home strip |

## Rules (product)

1. **Create:** admin / zone, region, or division officer — offices only **under** their scope (`lib/offices.js`).
2. **Assignment unit:** one assignment + one submission per office; any user at that office may edit.
3. **Stamp** on every write: email, name, username, office, time, IP, `late` boolean.
4. **Deadline:** `due_at` required; optional `extended_due_at` (> due). Locked when `now > due_at` and (no extension or `now > extended_due_at`). Late window: `due_at < now ≤ extended_due_at`.

## Collections

`app_collect_templates`, `app_collect_requests`, `app_collect_assignments`, `app_collect_submissions` — API rules all null (server superuser only).

## API

| Route | Who | Purpose |
|---|---|---|
| `GET /api/collect/status` | signed in | `{ available, pending_count, can_create }` for the shell badge |
| `GET /api/collect/inbox` | signed in | Assignments for **this** office + timing chips |
| `GET /api/collect/requests` | creators | Requests I opened (admins: open requests) |
| `POST /api/collect/requests` | creators | Create request + assignments + empty drafts |
| `POST /api/collect/requests/:id/extend` | requester or admin | Set `extended_due_at` |
| `GET /api/collect/offices` | creators | Offices under my scope (picker) |

## Phases

- **P0 (this):** collections, inbox/status/create/extend, shell + Home badges, countdown / locked / late chips. Schema is empty (`{ fields: [] }`); fill UI comes next.
- **P1:** template builder + draft save / submit with lock enforcement.
- **P2:** nested groups (Block → Village → Para → Scheme) + hierarchy viewer + add/remove offices on a live request.
- **P3:** return-for-correction, export, revision history.

## Deploy

Push to `develop` for the VM. PocketBase applies `1794300000` on deploy (PocketBase restart when migrations change). Confirm `/api/collect/status` returns `available: true` after sign-in.
