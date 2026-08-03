# NSC Pending → Supabase (`mzo_insight`)

Stores the **cleaned** Pending NSC dataset (Working + Accepted) after dm1 uploads a raw Excel.

## Tables

| Table | Purpose |
|-------|---------|
| `nsc_upload_meta` | Who uploaded, when, row counts, active flag |
| `nsc_pending` | Dashboard rows for the active upload |

## Setup

1. Supabase → **SQL Editor** → run [`create_mzo_insight_nsc_pending.sql`](create_mzo_insight_nsc_pending.sql)
2. **Settings → API → Exposed schemas** → include `mzo_insight` (if not already)
3. Restart / redeploy the app

## App flow

1. dm1 uploads raw `.xlsb` / `.xlsx` at `/nsc/upload.html`
2. Server transforms (same rules as Google Sheet cleanup)
3. Writes:
   - Supabase `nsc_pending` (source of truth)
   - Local `data/nsc.csv` backup (gitignored)
4. Dashboards read `/api/nsc/dataset` → Supabase → local CSV → Google Sheet fallback

## Access

Upload restricted to username **`dm1`** for now.
