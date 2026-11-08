# DISHA Collect

VM-only workflow: **admin, region and division officers** request structured reports from subordinate offices. Assignees share **one draft per office** (last-writer stamp). After the due time the form locks; the requester may **extend** the deadline — saves in that window are stamped **`late`**.

Not available on Vercel (needs PocketBase). Local checkouts without `PB_URL` + superuser get `503` / `available: false`.

| Where | What |
|---|---|
| `lib/collect.js` | PocketBase client, scope rules, `/api/collect/*` |
| `collect/index.html` + `collect/collect_app.js` | Left nav + right work; create Basics → Who → Format (type/add in side panel); fill, hierarchy, export |
| `GET /api/collect/users` | Active users under the requester’s scope (for optional people pick) |
| `vm/pocketbase/pb_migrations/1794300000_app_collect.js` | Collections |
| `vm/dev/test-collect.js` | Helpers, then every route against an in-memory PocketBase stub (`npm test`); `--pb` repeats the route checks on a local PocketBase (`npm test -- --pb`) |
| Shell | Top-bar pill + sidebar badge when `pending_count > 0`; Home strip |

## Rules

1. **Create:** admin / zone, region, or division officer — offices only **under** their scope.
2. **Office picks:** All · Clear · **All RM** (regions) · **All DM** (divisions) · **All SM** (CCCs), plus individual ticks.
3. **Assignment unit:** one assignment + one submission per office; any user at that office may edit.
4. **Stamp** on every write: email, name, username, office, time, IP, `late` boolean.
5. **Deadline:** locked when past `due_at` with no open `extended_due_at`; late window allows edit with `late` stamp.
6. **Return:** requester can return a submitted assignment (only while still editable / extended) so the office can correct it.
7. **Managing a request** (tree, export, extend, add/withdraw offices, return): admin and zone officers for every request; a region or division officer for the requests they raised, and only while they still hold that office.
8. **Who is asking** comes from the signed-in user's current profile (`currentUser` in `server.js`), never from the body: a disabled account gets 401, a demoted one loses its rights at once.

## Limits and validation

- **Format:** stored as `{ fields: [{ id, type, label, required, repeat?, children? }] }` only. Types `text number checkbox date textarea group`; ids keep letters, digits, `_`, `-`, are unique among siblings and never an `Object.prototype` name (renamed otherwise). At most 150 columns and 4 levels.
- **Draft:** cut to the format on every save (unknown keys dropped, values coerced to the column type), at most 500 rows per table, 20 000 values, 2 000 characters per text (10 000 long text) and 800 KB in all (`413` over).
- **Times:** `due_at` and `extended_due_at` must be in the future and within a year; the extension after the due time. Extending also moves submitted offices, so a later return reopens them.
- **Picks:** at most 200 offices per create/add, 500 people, 200 ids per withdraw. Regions, divisions and CCCs must exist in `lib/offices.js`.
- **Ids** in the URL must look like PocketBase ids (15 lowercase letters/digits), else `404`.
- **Errors:** only Collect's own messages reach the page; a PocketBase failure answers `502`/`503` with a plain message (details in the server log).
- **Export** is JSON. A future CSV/Excel export must prefix cells starting with `= + - @` (or tab/CR) with `'`.

## API

| Route | Purpose |
|---|---|
| `GET /api/collect/status` | Shell badge `{ available, pending_count, can_create }` (`available: false` with 200 where Collect is off) |
| `GET /api/collect/inbox` | Assignments for this office |
| `GET/POST /api/collect/requests` | List mine / create |
| `GET /api/collect/requests/:id` | Hierarchy for requester |
| `GET /api/collect/requests/:id/export` | JSON export of nested answers |
| `POST /api/collect/requests/:id/extend` | Set `extended_due_at` |
| `POST /api/collect/requests/:id/offices` | Add offices |
| `POST /api/collect/requests/:id/offices/remove` | Withdraw pending assignments |
| `GET /api/collect/assignments/:id` | Schema + payload for fill (+ `revision`) |
| `PUT /api/collect/assignments/:id/draft` | Save shared draft; optional `base_revision` (the revision loaded) → `409` if someone saved since |
| `POST /api/collect/assignments/:id/submit` | Submit |
| `POST /api/collect/assignments/:id/return` | Unlock for correction |
| `GET /api/collect/offices` | Offices under my scope |
| `GET /api/collect/users` | Active people under my scope: name, email, office (no usernames or phones) |

## Test

```
node vm/dev/test-collect.js
node vm/dev/test-collect.js --pb   # needs local PocketBase binary (PB_BIN=…)
```

## Deploy

Push to `develop`. PocketBase applies `1794300000` when migrations change. Confirm `/api/collect/status` → `available: true` after sign-in on the VM.
