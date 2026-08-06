# NSC Pending + Withheld → Supabase (`mzo_insight`)

Stores cleaned NSC datasets after an authorised user uploads the SAP Excel at `/nsc/upload.html`.

## Tables

| Table | Purpose |
|-------|---------|
| `nsc_upload_meta` | Who uploaded, when, row counts, active flag |
| `nsc_pending` | Working/Accepted rows for the active upload |
| `nsc_withheld` | Withheld rows for the same active upload |

## Setup

1. Supabase → **SQL Editor** → run [`create_mzo_insight_nsc_pending.sql`](create_mzo_insight_nsc_pending.sql)
2. Same editor → run [`create_mzo_insight_nsc_withheld.sql`](create_mzo_insight_nsc_withheld.sql)
3. **Settings → API → Exposed schemas** → include `mzo_insight` (if not already)
4. Restart / redeploy the app

## App flow

1. Authorised user opens `/nsc/upload.html`, picks data date + Excel
2. Browser cleans the file (Working/Accepted + Withheld)
3. Chunked publish with live progress:
   - `POST /api/nsc/publish/begin`
   - `POST /api/nsc/publish/chunk` (pending, then withheld)
   - `POST /api/nsc/publish/complete` (activates snapshot)
4. Dashboards:
   - NSC → `/api/nsc/dataset`
   - Withheld → `/api/withheld/dataset`

## Access

Upload requires `nsc_upload_autho` (or legacy `dm1`). Grant via Admin → User Management → **NSC Raw Upload**.
