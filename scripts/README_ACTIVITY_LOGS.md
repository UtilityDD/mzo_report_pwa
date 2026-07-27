# Activity logs → `mzo_insight.activity_logs`

Replaces Google Sheet / Apps Script as the source of truth for portal activity logs.

## Steps

1. **SQL Editor** — run [`create_mzo_insight_activity_logs.sql`](create_mzo_insight_activity_logs.sql)

2. **Optional one-time import** of old Google logs:
   ```bash
   npm run migrate:activity-logs
   ```

3. Deploy server — new logs write to Supabase; Admin → Logs reads from Supabase.

4. After verifying logs in Admin / Table Editor, delete the Google Sheet and Apps Script.

Power Map / SI / `portal_users` are untouched.
