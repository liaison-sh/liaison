// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo analytics warehouse's shape: the tables an ops team at a small
// hardware company would actually have in a reporting database, rather than a
// single flat "sales" table nobody would believe.
//
// It is a WAREHOUSE, not the operational store: money is carried in minor
// units as integers, dates are dates (no timestamps a report never uses), and
// `monthly_revenue` is a pre-aggregated mart on top of the order grain, the
// way a real deployment materialises the number a dashboard reads twenty times
// a day.
//
// It holds NO secrets by construction. There is no token column, no password
// hash, no signed license: every column is an invented commercial fact about an
// invented company, which is why the read-only role gets plain table SELECT
// rather than the column-scoped grant the liaison-self adapter needs. That is
// what lets an agent answer a question nobody wrote a curated read for.

import { DEMO_WAREHOUSE_SCHEMA as S } from "./sentinel"

/** Every table in the warehouse, in dependency order. Also the TRUNCATE order. */
export const DEMO_WAREHOUSE_TABLES = [
  "products",
  "dealers",
  "customers",
  "rma_reasons",
  "orders",
  "order_lines",
  "rmas",
  "inventory_movements",
  "device_telemetry",
  "warranties",
  "monthly_revenue",
] as const

/**
 * The one table that is not part of the dataset: a single row saying when the
 * warehouse was last built and how big it came out. `ensureDemoWarehouse` reads
 * it to decide whether a rebuild is needed, and an agent can read it to say how
 * fresh the numbers are.
 */
export const DEMO_WAREHOUSE_BUILD_TABLE = "build_info"

/**
 * The DDL, idempotent end to end: every statement is CREATE ... IF NOT EXISTS,
 * so a re-deploy converges instead of failing, and the row load that follows
 * truncates rather than upserting.
 */
export const DEMO_WAREHOUSE_DDL = `
CREATE SCHEMA IF NOT EXISTS ${S};

CREATE TABLE IF NOT EXISTS ${S}.products (
  sku                text PRIMARY KEY,
  title              text NOT NULL,
  tier               text NOT NULL,
  list_price_minor   integer NOT NULL,
  currency           text NOT NULL,
  weight_kg          numeric(6,2) NOT NULL,
  launched_on        date NOT NULL,
  is_serialized      boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS ${S}.dealers (
  dealer_code        text PRIMARY KEY,
  name               text NOT NULL,
  country            text NOT NULL,
  tier               text NOT NULL,
  credit_terms_days  integer NOT NULL,
  credit_limit_minor integer NOT NULL,
  vat_number         text,
  onboarded_on       date NOT NULL
);

CREATE TABLE IF NOT EXISTS ${S}.customers (
  customer_code      text PRIMARY KEY,
  name               text NOT NULL,
  email              text NOT NULL,
  country            text NOT NULL,
  segment            text NOT NULL,
  first_order_on     date NOT NULL
);

CREATE TABLE IF NOT EXISTS ${S}.rma_reasons (
  reason_code        text PRIMARY KEY,
  label              text NOT NULL,
  category           text NOT NULL,
  is_hardware_fault  boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS ${S}.orders (
  order_id           text PRIMARY KEY,
  order_ref          text NOT NULL,
  order_date         date NOT NULL,
  channel            text NOT NULL,
  customer_code      text REFERENCES ${S}.customers(customer_code),
  dealer_code        text REFERENCES ${S}.dealers(dealer_code),
  currency           text NOT NULL,
  subtotal_minor     integer NOT NULL,
  discount_minor     integer NOT NULL,
  shipping_minor     integer NOT NULL,
  tax_minor          integer NOT NULL,
  total_minor        integer NOT NULL,
  ship_country       text NOT NULL,
  status             text NOT NULL,
  due_on             date,
  paid_on            date
);

CREATE TABLE IF NOT EXISTS ${S}.order_lines (
  line_id            text PRIMARY KEY,
  order_id           text NOT NULL REFERENCES ${S}.orders(order_id),
  line_no            integer NOT NULL,
  sku                text NOT NULL REFERENCES ${S}.products(sku),
  quantity           integer NOT NULL,
  unit_price_minor   integer NOT NULL,
  discount_minor     integer NOT NULL,
  line_total_minor   integer NOT NULL
);

CREATE TABLE IF NOT EXISTS ${S}.rmas (
  rma_id             text PRIMARY KEY,
  rma_ref            text NOT NULL,
  order_id           text NOT NULL REFERENCES ${S}.orders(order_id),
  sku                text NOT NULL REFERENCES ${S}.products(sku),
  serial_number      text,
  reason_code        text NOT NULL REFERENCES ${S}.rma_reasons(reason_code),
  firmware_version   text,
  opened_on          date NOT NULL,
  closed_on          date,
  status             text NOT NULL,
  resolution         text,
  refund_minor       integer NOT NULL,
  ship_country       text NOT NULL
);

CREATE TABLE IF NOT EXISTS ${S}.inventory_movements (
  movement_id        text PRIMARY KEY,
  sku                text NOT NULL REFERENCES ${S}.products(sku),
  moved_on           date NOT NULL,
  movement_type      text NOT NULL,
  quantity           integer NOT NULL,
  location           text NOT NULL,
  reference          text
);

CREATE TABLE IF NOT EXISTS ${S}.device_telemetry (
  report_id          text PRIMARY KEY,
  serial_number      text NOT NULL,
  sku                text NOT NULL REFERENCES ${S}.products(sku),
  firmware_version   text NOT NULL,
  reported_on        date NOT NULL,
  country            text NOT NULL,
  uptime_hours       integer NOT NULL,
  crash_count        integer NOT NULL,
  session_count      integer NOT NULL
);

CREATE TABLE IF NOT EXISTS ${S}.warranties (
  warranty_id        text PRIMARY KEY,
  serial_number      text NOT NULL,
  sku                text NOT NULL REFERENCES ${S}.products(sku),
  order_id           text NOT NULL REFERENCES ${S}.orders(order_id),
  plan               text NOT NULL,
  started_on         date NOT NULL,
  ends_on            date NOT NULL,
  status             text NOT NULL
);

CREATE TABLE IF NOT EXISTS ${S}.monthly_revenue (
  month              date NOT NULL,
  channel            text NOT NULL,
  sku                text NOT NULL REFERENCES ${S}.products(sku),
  units              integer NOT NULL,
  gross_revenue_minor integer NOT NULL,
  refunds_minor      integer NOT NULL,
  net_revenue_minor  integer NOT NULL,
  currency           text NOT NULL,
  PRIMARY KEY (month, channel, sku)
);

CREATE TABLE IF NOT EXISTS ${S}.build_info (
  id                 integer PRIMARY KEY,
  built_on           date NOT NULL,
  row_total          integer NOT NULL,
  history_months     integer NOT NULL,
  built_at           timestamptz NOT NULL
);

-- Added after a deploy that changed every product NAME and no row COUNT, so
-- the stamp matched and the warehouse kept serving the previous catalog. A box
-- provisioned before this column exists must gain it rather than be rebuilt
-- from scratch, hence ADD COLUMN IF NOT EXISTS beside the CREATE above.
ALTER TABLE ${S}.build_info ADD COLUMN IF NOT EXISTS content_hash text;

CREATE INDEX IF NOT EXISTS orders_order_date_idx ON ${S}.orders (order_date);
CREATE INDEX IF NOT EXISTS orders_dealer_idx ON ${S}.orders (dealer_code);
CREATE INDEX IF NOT EXISTS order_lines_sku_idx ON ${S}.order_lines (sku);
CREATE INDEX IF NOT EXISTS rmas_sku_idx ON ${S}.rmas (sku);
CREATE INDEX IF NOT EXISTS rmas_opened_idx ON ${S}.rmas (opened_on);
CREATE INDEX IF NOT EXISTS inventory_movements_sku_idx ON ${S}.inventory_movements (sku, moved_on);
CREATE INDEX IF NOT EXISTS telemetry_sku_fw_idx ON ${S}.device_telemetry (sku, firmware_version);
CREATE INDEX IF NOT EXISTS monthly_revenue_month_idx ON ${S}.monthly_revenue (month);
`

/**
 * The login role and its grants, rendered for `loginRole`; `passwordLiteral`
 * is an already-quoted SQL literal (`quote_literal`). Schema-wide SELECT rather than the
 * column-scoped allow-list the liaison-self adapter renders, and deliberately:
 * this schema holds no secret column to withhold, and the demo's headline is an
 * agent answering a question nobody anticipated, which a column allow-list
 * would turn into a permission error. The wall that matters is the other
 * direction, and it is absolute: this role is granted NOTHING outside
 * `${S}`, so kernel, app_tickets, app_mail and every other Liaison schema are
 * invisible to it.
 */
export function demoWarehouseGrants(loginRole: string, passwordLiteral: string): string {
  return `
DO $demo_grants$
DECLARE m record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${loginRole}') THEN
    CREATE ROLE ${loginRole} LOGIN PASSWORD ${passwordLiteral};
  END IF;
  -- Converge an existing role on every run: the password follows the
  -- deployment's DSN, the attributes are pinned, and any membership it ever
  -- picked up (the old SET ROLE design granted one) is revoked, so the login is
  -- a member of nothing.
  ALTER ROLE ${loginRole} WITH LOGIN PASSWORD ${passwordLiteral}
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20;
  FOR m IN SELECT g.rolname AS grp FROM pg_auth_members am
      JOIN pg_roles g ON g.oid = am.roleid
      JOIN pg_roles u ON u.oid = am.member WHERE u.rolname = '${loginRole}' LOOP
    EXECUTE format('REVOKE %I FROM ${loginRole}', m.grp);
  END LOOP;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${loginRole}', current_database());
  -- The earlier design handed a NOLOGIN read-only role to the application's own
  -- login; take every such membership back.
  FOR m IN SELECT u.rolname AS usr FROM pg_auth_members am
      JOIN pg_roles g ON g.oid = am.roleid
      JOIN pg_roles u ON u.oid = am.member WHERE g.rolname = 'liaison_demo_warehouse_ro' LOOP
    EXECUTE format('REVOKE liaison_demo_warehouse_ro FROM %I', m.usr);
  END LOOP;
END $demo_grants$;
REVOKE ALL ON SCHEMA ${S} FROM ${loginRole};
GRANT USAGE ON SCHEMA ${S} TO ${loginRole};
GRANT SELECT ON ALL TABLES IN SCHEMA ${S} TO ${loginRole};
ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} GRANT SELECT ON TABLES TO ${loginRole};
`
}
