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
