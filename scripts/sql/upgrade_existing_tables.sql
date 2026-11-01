-- Columns added to existing tables over time: portal_users module flags and Google sign-in fields,
-- Priority SI money fields, stock allotment cancel, stock snapshot category.
-- Run on a project created before these columns existed. Every ALTER is guarded (IF NOT EXISTS),
-- so the file is safe to run more than once. Order matters: the Google sign-in block seeds a row
-- that uses the flag columns added above it.

-- ======================================================================
-- from alter_portal_users_all_sync_auth.sql
-- ======================================================================
-- Cloud Sync permissions on portal_users for Disconnection, Pending MC, and Pending Load Extension
-- Run in Supabase Dashboard → SQL Editor → Run
--
-- pending_mc_sync_autho: '' | 'Y' (Master Card 1-click cloud sync)
-- load_ext_sync_autho: '' | 'Y' (Load Extension 1-click cloud sync)
-- disconnection_sync_autho: '' | 'Y' (Disconnection Tracker 1-click cloud sync)

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS disconnection_sync_autho text DEFAULT '',
  ADD COLUMN IF NOT EXISTS pending_mc_sync_autho text DEFAULT '',
  ADD COLUMN IF NOT EXISTS load_ext_sync_autho text DEFAULT '';

-- Authorize default operator 'dm1' if blank
UPDATE mzo_insight.portal_users
SET pending_mc_sync_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(pending_mc_sync_autho), ''), '') = '';

UPDATE mzo_insight.portal_users
SET load_ext_sync_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(load_ext_sync_autho), ''), '') = '';

UPDATE mzo_insight.portal_users
SET disconnection_sync_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(disconnection_sync_autho), ''), '') = '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name IN ('disconnection_sync_autho', 'pending_mc_sync_autho', 'load_ext_sync_autho');

-- ======================================================================
-- from alter_portal_users_defective_upload_auth.sql
-- ======================================================================
-- Defective meter CSV upload permission on portal_users
-- Run in Supabase Dashboard → SQL Editor → Run
-- Then NOTIFY so PostgREST exposes the new column.
--
-- defective_upload_autho: '' | 'Y'
--   Y = can publish defective-meter CSV on /consumer/defective_meter.html
-- Admins can always upload (server-side), even if this flag is blank.

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS defective_upload_autho text DEFAULT '';

UPDATE mzo_insight.portal_users
SET defective_upload_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(defective_upload_autho), ''), '') = '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name = 'defective_upload_autho';

-- ======================================================================
-- from alter_portal_users_disconnection_sync_auth.sql
-- ======================================================================
-- Disconnection Sheet Cloud Sync permission on portal_users
-- Run in Supabase Dashboard → SQL Editor → Run
-- Then NOTIFY so PostgREST exposes the new column.
--
-- disconnection_sync_autho: '' | 'Y'
--   Y = can trigger 1-click cloud sync on /disconnection.html
-- Admins can always sync (server-side), even if this flag is blank.

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS disconnection_sync_autho text DEFAULT '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name = 'disconnection_sync_autho';

-- ======================================================================
-- from alter_portal_users_nsc_upload_auth.sql
-- ======================================================================
-- NSC raw Excel upload permission on portal_users
-- Run in Supabase Dashboard → SQL Editor → Run
--
-- nsc_upload_autho: '' | 'Y'
--   Y = can upload raw NSC Excel at /nsc/upload.html

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS nsc_upload_autho text DEFAULT '';

-- Keep existing operator working until admin reassigns in portal
UPDATE mzo_insight.portal_users
SET nsc_upload_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(nsc_upload_autho), ''), '') = '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name = 'nsc_upload_autho';

-- ======================================================================
-- from alter_portal_users_sheets_auth.sql
-- ======================================================================
-- Add Important Sheets manage permission on portal_users
-- Run in Supabase Dashboard → SQL Editor → Run
--
-- sheets_autho: '' | 'list' | 'view' | 'edit'
--   list = home-bar Sheet links button (Google Sheet list only)
--   edit = Manage unbilled months on important_sheets.html, and the Sheet links button
--   admins always can manage and open Sheet links regardless of this flag

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS sheets_autho text DEFAULT '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name = 'sheets_autho';

-- ======================================================================
-- from alter_portal_users_si_auth.sql
-- ======================================================================
-- Add Priority SI Works auth columns to mzo_insight.portal_users
-- Run in Supabase Dashboard → SQL Editor → Run
--
-- si_autho: '' | 'view' | 'edit'   (blank/view = view-only; edit = can mutate)
-- si_divisions: '' | 'ALL' | 'Malda,Chanchal,...'  (comma-separated; only used when si_autho=edit)
-- Viewers see all divisions. Editors are limited to listed divisions (or ALL).

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS si_autho text DEFAULT '';

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS si_divisions text DEFAULT '';

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'portal_users'
  AND column_name IN ('si_autho', 'si_divisions');

-- ======================================================================
-- from alter_portal_users_stock_auth.sql
-- ======================================================================
-- Stock upload + allotment create permissions on portal_users
-- Run in Supabase SQL Editor
--
-- stock_upload_autho: '' | 'Y'  → can upload SAP stock dump
-- stock_allot_autho:  '' | 'Y'  → can create allotments / diversions

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS stock_upload_autho text DEFAULT '';

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS stock_allot_autho text DEFAULT '';

UPDATE mzo_insight.portal_users
SET stock_allot_autho = 'Y'
WHERE lower(username) IN ('zm', 'aritra', 'dm1')
  AND coalesce(nullif(trim(stock_allot_autho), ''), '') = '';

UPDATE mzo_insight.portal_users
SET stock_upload_autho = 'Y'
WHERE lower(username) = 'dm1'
  AND coalesce(nullif(trim(stock_upload_autho), ''), '') = '';

NOTIFY pgrst, 'reload schema';

SELECT username, stock_upload_autho, stock_allot_autho
FROM mzo_insight.portal_users
WHERE lower(username) IN ('zm', 'aritra', 'dm1')
ORDER BY username;

-- ======================================================================
-- from alter_portal_users_stock_cancel_auth.sql
-- ======================================================================
-- Separate Stock Allot Cancel permission (independent of create)
-- Run in Supabase SQL Editor
--
-- stock_cancel_autho: '' | 'Y'  → can soft-cancel allotments (cannot revert)

ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS stock_cancel_autho text DEFAULT '';

NOTIFY pgrst, 'reload schema';

-- No auto-seed: grant Cancel only via Admin → User Management → Stock Allot Cancel
SELECT username, stock_allot_autho, stock_cancel_autho
FROM mzo_insight.portal_users
WHERE coalesce(nullif(trim(stock_allot_autho), ''), '') <> ''
   OR coalesce(nullif(trim(stock_cancel_autho), ''), '') <> ''
ORDER BY username;

-- ======================================================================
-- from alter_portal_users_google_auth.sql
-- ======================================================================
-- ====================================================================
-- Migration: Add Google Auth & Admin Approval Fields to portal_users
-- Schema: mzo_insight
-- Run in: Supabase Dashboard -> SQL Editor -> Run
-- ====================================================================

-- 1. Add email and Google Auth fields
ALTER TABLE mzo_insight.portal_users
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS auth_provider text DEFAULT 'pin',
  ADD COLUMN IF NOT EXISTS user_status text DEFAULT 'active', -- 'pending', 'active', 'rejected', 'suspended'
  ADD COLUMN IF NOT EXISTS office_level text DEFAULT 'CCC',   -- 'CE', 'ZONE', 'REGION', 'DIVN', 'CCC'
  ADD COLUMN IF NOT EXISTS upload_permissions text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS can_comment boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS requested_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- 2. Create index on email for instant lookups
CREATE INDEX IF NOT EXISTS idx_portal_users_email 
  ON mzo_insight.portal_users(lower(email));

-- 3. Set existing users to active
UPDATE mzo_insight.portal_users
SET user_status = 'active'
WHERE user_status IS NULL OR user_status = '';

-- 4. Seed/Ensure smartlinemanapp@gmail.com is Root Administrator
INSERT INTO mzo_insight.portal_users (
  username,
  email,
  name,
  role,
  auth_provider,
  user_status,
  office_level,
  sheets_autho,
  can_comment,
  disconnection_sync_autho,
  pending_mc_sync_autho,
  load_ext_sync_autho,
  defective_upload_autho,
  nsc_upload_autho,
  stock_upload_autho,
  stock_allot_autho,
  stock_cancel_autho,
  upload_permissions,
  approved_by,
  approved_at
)
VALUES (
  'smartlineman',
  'smartlinemanapp@gmail.com',
  'Smart Lineman Admin',
  'admin',
  'google',
  'active',
  'CE',
  'edit',
  true,
  'Y', 'Y', 'Y', 'Y', 'Y', 'Y', 'Y', 'Y',
  ARRAY['disconnection', 'pending_mc', 'load_ext', 'defective', 'nsc', 'stock', 'stock_allot', 'stock_cancel'],
  'system_root',
  now()
)
ON CONFLICT (username) DO UPDATE
SET 
  email = 'smartlinemanapp@gmail.com',
  role = 'admin',
  user_status = 'active',
  auth_provider = 'google',
  office_level = 'CE',
  sheets_autho = 'edit',
  can_comment = true,
  disconnection_sync_autho = 'Y',
  pending_mc_sync_autho = 'Y',
  load_ext_sync_autho = 'Y',
  defective_upload_autho = 'Y',
  nsc_upload_autho = 'Y',
  stock_upload_autho = 'Y',
  stock_allot_autho = 'Y',
  stock_cancel_autho = 'Y',
  approved_by = 'system_root',
  approved_at = now();

-- 5. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

-- 6. Verification query
SELECT id, username, email, role, user_status, office_level, auth_provider
FROM mzo_insight.portal_users
WHERE lower(email) = 'smartlinemanapp@gmail.com' OR lower(username) = 'smartlineman';

-- ======================================================================
-- from alter_prioritysi_money_fields.sql
-- ======================================================================
-- Add SI money fields (run in Supabase SQL editor against mzo_insight)
-- Values stored in Rupees (numeric); UI shows Lakh / Crore compact labels.

ALTER TABLE mzo_insight."prioritySI"
  ADD COLUMN IF NOT EXISTS "TAA Value (Rs.)" numeric,
  ADD COLUMN IF NOT EXISTS "Billed Value till date (Rs.)" numeric;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'mzo_insight'
  AND table_name = 'prioritySI'
  AND column_name IN ('TAA Value (Rs.)', 'Billed Value till date (Rs.)');

-- ======================================================================
-- from alter_stock_allotments_cancel.sql
-- ======================================================================
-- Soft-cancel support for stock allotments (keep rows; mark cancelled)
-- Run in Supabase SQL Editor AFTER using Cancel in the portal

ALTER TABLE mzo_insight.stock_allotments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

ALTER TABLE mzo_insight.stock_allotments
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE mzo_insight.stock_allotments
  ADD COLUMN IF NOT EXISTS cancelled_by text NOT NULL DEFAULT '';

ALTER TABLE mzo_insight.stock_allotments
  ADD COLUMN IF NOT EXISTS cancel_reason text NOT NULL DEFAULT '';

-- Backfill any nulls from older rows
UPDATE mzo_insight.stock_allotments
SET status = 'active'
WHERE status IS NULL OR trim(status) = '';

CREATE INDEX IF NOT EXISTS stock_allotments_status_idx
  ON mzo_insight.stock_allotments (status);

NOTIFY pgrst, 'reload schema';

-- ======================================================================
-- from alter_stock_snapshot_add_category.sql
-- ======================================================================
-- Add Category (LOCAL / CENTRAL) to existing stock_snapshot
-- Run in Supabase SQL Editor if table was created before Category support

ALTER TABLE mzo_insight.stock_snapshot
  ADD COLUMN IF NOT EXISTS category text;

NOTIFY pgrst, 'reload schema';
