-- Public read + signed upload for bucket "stock"
-- Run in SQL Editor if browser PUT of snapshot.csv is denied.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('stock', 'stock', true, 52428800)
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = 52428800;

DROP POLICY IF EXISTS stock_public_read ON storage.objects;
CREATE POLICY stock_public_read
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'stock');

DROP POLICY IF EXISTS stock_signed_insert ON storage.objects;
CREATE POLICY stock_signed_insert
  ON storage.objects FOR INSERT
  TO anon, authenticated, service_role
  WITH CHECK (bucket_id = 'stock');

DROP POLICY IF EXISTS stock_signed_update ON storage.objects;
CREATE POLICY stock_signed_update
  ON storage.objects FOR UPDATE
  TO anon, authenticated, service_role
  USING (bucket_id = 'stock')
  WITH CHECK (bucket_id = 'stock');
