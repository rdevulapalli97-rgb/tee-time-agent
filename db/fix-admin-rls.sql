-- ============================================================
-- fix-admin-rls.sql
-- Run this in Supabase SQL Editor to allow the admin dashboard
-- to read data using the anon (publishable) key.
-- ============================================================

-- 1. Grant SELECT on the view to the anon role
GRANT SELECT ON user_summary TO anon;

-- 2. Grant SELECT on underlying tables (needed for view + direct queries)
GRANT SELECT ON users TO anon;
GRANT SELECT ON bookings TO anon;
GRANT SELECT ON booking_attempts TO anon;
GRANT SELECT ON user_configs TO anon;

-- 3. RLS policy: anon can read all users (admin dashboard only — no public UI)
DROP POLICY IF EXISTS "anon_read_users" ON users;
CREATE POLICY "anon_read_users"
  ON users FOR SELECT
  TO anon
  USING (true);

-- 4. RLS policy: anon can read all bookings
DROP POLICY IF EXISTS "anon_read_bookings" ON bookings;
CREATE POLICY "anon_read_bookings"
  ON bookings FOR SELECT
  TO anon
  USING (true);

-- 5. RLS policy: anon can read all booking_attempts
DROP POLICY IF EXISTS "anon_read_booking_attempts" ON booking_attempts;
CREATE POLICY "anon_read_booking_attempts"
  ON booking_attempts FOR SELECT
  TO anon
  USING (true);

-- 6. RLS policy: anon can read all user_configs
DROP POLICY IF EXISTS "anon_read_user_configs" ON user_configs;
CREATE POLICY "anon_read_user_configs"
  ON user_configs FOR SELECT
  TO anon
  USING (true);

-- 7. Also allow anon to INSERT into users (for the "+ Add User" modal)
DROP POLICY IF EXISTS "anon_insert_users" ON users;
CREATE POLICY "anon_insert_users"
  ON users FOR INSERT
  TO anon
  WITH CHECK (true);

-- Verify
SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
