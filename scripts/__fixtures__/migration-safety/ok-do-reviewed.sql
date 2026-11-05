-- SPDX-License-Identifier: FSL-1.1-ALv2
-- reviewed-dynamic: grants the new role on every app schema; adds privileges only
DO $$
BEGIN
  EXECUTE 'GRANT USAGE ON SCHEMA kernel TO liaison_reader';
END
$$;
