# DISHA Collect

VM-only workflow: **admin, region and division officers** request structured reports from subordinate offices. Assignees share **one draft per office** (last-writer stamp). After the due time the form locks; the requester may **extend** the deadline — saves in that window are stamped **`late`**.

Not available on Vercel (needs PocketBase). Local checkouts without `PB_URL` + superuser get `503` / `available: false`.

| Where | What |
|---|---|
| `lib/collect.js` | PocketBase client, scope rules, `/api/collect/*` |
| `collect/index.html` + `collect/collect_app.js` | Inbox, 3-step create (Basics → Who → Format: name / type / +), fill, hierarchy, export |
| `GET /api/collect/users` | Active users under the requester’s scope (for optional people pick) |
| `vm/pocketbase/pb_migrations/1794300000_app_collect.js` | Collections |
| `vm/dev/test-collect.js` | Timing/office unit tests; `--pb` live round-trip |
| Shell | Top-bar pill + sidebar badge when `pending_count > 0`; Home strip |

## Rules

1. **Create:** admin / zone, region, or division officer — offices only **under** their scope.
2. **Office picks:** All · Clear · **All RM** (regions) · **All DM** (divisions) · **All SM** (CCCs), plus individual ticks.
3. **Assignment unit:** one assignment + one submission per office; any user at that office may edit.
4. **Stamp** on every write: email, name, username, office, time, IP, `late` boolean.
5. **Deadline:** locked when past `due_at` with no open `extended_due_at`; late window allows edit with `late` stamp.
6. **Return:** requester can return a submitted assignment (only while still editable / extended) so the office can correct it.

## API

| Route | Purpose |
|---|---|
| `GET /api/collect/status` | Shell badge `{ available, pending_count, can_create }` |
| `GET /api/collect/inbox` | Assignments for this office |
| `GET/POST /api/collect/requests` | List mine / create |
| `GET /api/collect/requests/:id` | Hierarchy for requester |
| `GET /api/collect/requests/:id/export` | JSON export of nested answers |
| `POST /api/collect/requests/:id/extend` | Set `extended_due_at` |
| `POST /api/collect/requests/:id/offices` | Add offices |
| `POST /api/collect/requests/:id/offices/remove` | Withdraw pending assignments |
| `GET /api/collect/assignments/:id` | Schema + payload for fill |
| `PUT /api/collect/assignments/:id/draft` | Save shared draft |
| `POST /api/collect/assignments/:id/submit` | Submit |
| `POST /api/collect/assignments/:id/return` | Unlock for correction |
| `GET /api/collect/offices` | Offices under my scope |

## Test

```
node vm/dev/test-collect.js
node vm/dev/test-collect.js --pb   # needs local PocketBase binary
```

## Deploy

Push to `develop`. PocketBase applies `1794300000` when migrations change. Confirm `/api/collect/status` → `available: true` after sign-in on the VM.
