-- SPDX-License-Identifier: FSL-1.1-ALv2
CREATE OR REPLACE FUNCTION kernel.current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;
