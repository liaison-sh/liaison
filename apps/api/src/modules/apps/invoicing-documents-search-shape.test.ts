// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression: the invoicing `documents_search` read tool returns a BARE
// `DocumentHeader[]` array (the HTTP route wraps it as `{ data: [...] }`, the
// api-client unwraps `.data`, so `host.invokeTool` resolves to the array). Its
// UI consumers — the dashboards loader (`searchDocuments`) and the contact
// panel (`loadPanel`) — must read that bare array. They previously read a
// non-existent `.items` envelope (the shape the `settings_*` list reads use),
// so the list view + awaiting-payment dashboard collapsed to their empty state
// ("No documents in this period" / "all paid") even though issued invoices
// existed and `documents_get(id)` rendered them fine.
//
// This exercises the REAL DB path end to end — NOT the createMockDb mock in
// `bundled-apps/invoicing/src/reads.test.ts` that masks the bug:
//   1. seed a real `app_invoicing.documents` table under the REAL generated RLS
//      policy and seed 3 issued invoices for one org;
//   2. build a real `ReadsCtx` whose `db.findMany` calls the REAL
//      createRpcBridge.db_findMany under the REAL withRlsContext (liaison_rls);
//   3. run the REAL `documentsSearchHandler` from the bundled app → produces the
//      bare-array tool result from real code;
//   4. install a host whose `invokeTool` returns that exact result and drive the
//      REAL UI consumers (`searchDocuments`, `loadPanel`) — assert they surface
//      all 3 rows.
//
// Fails-without-fix: with the consumers reading `r?.items ?? []`, step 4 yields
// an empty list despite step 3 returning 3 rows. Passes-with-fix: the consumers
// read the bare array and surface all 3.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { HostServices } from "@liaison/host"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { generateRlsPolicySql } from "~/modules/permissions/rls-generator"
import { documentsSearchHandler } from "../../../../../bundled-apps/invoicing/src/handlers"
import type { ReadsCtx } from "../../../../../bundled-apps/invoicing/src/reads"
// `dashboards/loader.ts` is a plain `.ts` module (no JSX), so it imports
// cleanly under the apps/api bun config. The `.tsx` ContactDocumentsPanel uses
// the SolidJS jsx-import-source and can only load under the bundled-app's own
// suite — its `loadPanel` bare-array extraction is pinned there
// (bundled-apps/invoicing/src/ui/ContactDocumentsPanel.test.tsx).
import { searchDocuments } from "../../../../../bundled-apps/invoicing/src/ui/dashboards/loader"

const PREFIX = "reg_ds_shape_" // matches /^[a-z][a-z0-9_]*_$/
const INV = `${PREFIX}app_invoicing`
const ORG = "00000000-0000-0000-0000-0000000000d2"
const USER = "00000000-0000-0000-0000-0000000000e2"
const ISSUER = "00000000-0000-0000-0000-0000000000f2"
const CONTACT = "00000000-0000-0000-0000-0000000000c2"

// Minimal-but-faithful subset of app.manifest.json schema.documents — enough
// for the bridge to accept `documents` as a known entity and the where/orderBy
// fields documentsSearch uses.
const MANIFEST = {
  name: "invoicing",
  schema: {
    documents: {
      fields: {
        type: "string",
        status: "string",
        payment_status: "string",
        number: "text?",
        number_int: "integer?",
        year_of_issue: "smallint?",
        issuer_profile_id: "uuid",
        counterparty_contact_id: "uuid?",
        counterparty_name: "text?",
        counterparty_country: "text?",
        currency: "string",
        subtotal_minor: "bigint",
        tax_total_minor: "bigint",
        grand_total_minor: "bigint",
        tax_treatment: "text?",
        incoterm: "string",
        issued_at: "date?",
        due_at: "date?",
        paid_at: "date?",
        voided_at: "date?",
        pdf_file_id: "uuid?",
        pdf_status: "string?",
        external_refs: "json",
        shopify_order_id: "text?",
        lifecycle_log: "json",
      },
    },
  },
} as const

const adminActor: ActorContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"], // wildcard admin, like the chaos observer admin@test.com
  dimensionGrants: {},
}

// A real ReadsCtx backed by the real createRpcBridge running under real RLS.
// `db.findMany` is exactly the generic-CRUD surface the runtime hands the
// invoicing read handlers.
const realCtx: ReadsCtx = {
  db: {
    findMany: (entity, opts) =>
      withRlsContext(adminActor, async (tx: RlsClient) => {
        const bridge = createRpcBridge(
          "invoicing",
          USER,
          ORG,
          tx,
          // biome-ignore lint/suspicious/noExplicitAny: test manifest is a faithful subset of the runtime ManifestApp shape.
          MANIFEST as any,
          ["*"],
        )
        const raw = await bridge.db_findMany("documents", JSON.stringify(opts ?? {}))
        return JSON.parse(raw) as unknown[]
      }),
    findOne: (entity, id) =>
      withRlsContext(adminActor, async (tx: RlsClient) => {
        const bridge = createRpcBridge(
          "invoicing",
          USER,
          ORG,
          tx,
          // biome-ignore lint/suspicious/noExplicitAny: see above.
          MANIFEST as any,
          ["*"],
        )
        const raw = await bridge.db_findOne("documents", id)
        // db_findOne JSON-stringifies its result (incl. `null`), so parse first.
        return raw == null ? null : (JSON.parse(raw) as unknown)
      }),
    count: (entity, opts) =>
      withRlsContext(adminActor, async (tx: RlsClient) => {
        const bridge = createRpcBridge(
          "invoicing",
          USER,
          ORG,
          tx,
          // biome-ignore lint/suspicious/noExplicitAny: see above.
          MANIFEST as any,
          ["*"],
        )
        // db_count returns a stringified integer (the countOnly sweep path).
        const raw = await bridge.db_count(entity, JSON.stringify(opts ?? {}))
        return Number(raw)
      }),
  },
  kernel: {
    listApprovals: async () => [],
  },
}

// Mirror the kernel's HTTP route + api-client: the handler return is wrapped as
// `{ data: <result> }` and the client unwraps `.data`, so `invokeTool` resolves
// to exactly the handler's return value (here, the bare DocumentHeader[]).
function installHostBackedByRealHandler(): void {
  const host: Partial<HostServices> & {
    invokeTool: HostServices["invokeTool"]
  } = {
    invokeTool: async <T>(
      _appName: string,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<T> => {
      if (toolName === "documents_search") {
        const result = await documentsSearchHandler(args, realCtx)
        return result as unknown as T
      }
      throw new Error(`unexpected tool in regression host: ${toolName}`)
    },
  }
  // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
  ;(globalThis as any).__liaisonHost = host
  // biome-ignore lint/suspicious/noExplicitAny: test-time bound app name for the `app` namespace.
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = "invoicing"
}

// `schemaRef`/`kernelRef` read process.env.SCHEMA_PREFIX at CALL time, so the
// prefix must be active while this test's bridge calls run — but it MUST be
// restored afterwards, or subsequent files in a flat `bun test` process resolve
// `${PREFIX}kernel.*` and fail with "relation does not exist".
let priorSchemaPrefix: string | undefined

beforeAll(async () => {
  priorSchemaPrefix = process.env.SCHEMA_PREFIX
  process.env.SCHEMA_PREFIX = PREFIX

  await withSystemDb("reg-ds-shape-setup", async (tx) => {
    await tx.execute(drizzleSql.raw(`DROP SCHEMA IF EXISTS "${INV}" CASCADE`))
    await tx.execute(drizzleSql.raw(`CREATE SCHEMA "${INV}"`))
    await tx.execute(
      drizzleSql.raw(`CREATE TABLE "${INV}".documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL,
        type text NOT NULL DEFAULT 'invoice',
        status text NOT NULL DEFAULT 'draft',
        payment_status text NOT NULL DEFAULT 'unpaid',
        number text,
        number_int integer,
        year_of_issue smallint,
        issuer_profile_id uuid NOT NULL,
        counterparty_contact_id uuid,
        counterparty_name text,
        counterparty_country text,
        currency text NOT NULL DEFAULT 'EUR',
        subtotal_minor bigint NOT NULL DEFAULT 0,
        tax_total_minor bigint NOT NULL DEFAULT 0,
        grand_total_minor bigint NOT NULL DEFAULT 0,
        tax_treatment text,
        incoterm text NOT NULL DEFAULT 'DAP',
        issued_at date,
        due_at date,
        paid_at date,
        voided_at date,
        pdf_file_id uuid,
        pdf_status text,
        external_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
        shopify_order_id text,
        lifecycle_log jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`),
    )
    for (const role of ["liaison_rls", "liaison_admin"]) {
      await tx.execute(drizzleSql.raw(`GRANT USAGE ON SCHEMA "${INV}" TO ${role}`)).catch(() => {})
      await tx
        .execute(drizzleSql.raw(`GRANT ALL ON ALL TABLES IN SCHEMA "${INV}" TO ${role}`))
        .catch(() => {})
    }
    // Generate + apply the EXACT RLS policy the runtime would for this entity
    // (no dimensions, no ownership → org + scope check only).
    const policySql = generateRlsPolicySql(
      INV,
      "documents",
      {},
      "invoicing",
      "documents",
      // biome-ignore lint/suspicious/noExplicitAny: field map mirrors the manifest shape the generator reads.
      MANIFEST.schema.documents.fields as any,
    )
    for (const stmt of policySql.split(";").filter((s) => s.trim())) {
      await tx.execute(drizzleSql.raw(`${stmt};`))
    }

    // Seed 3 issued invoices for ORG, one referencing CONTACT (for the panel).
    for (let i = 1; i <= 3; i++) {
      await tx.execute(
        drizzleSql`INSERT INTO ${drizzleSql.raw(`"${INV}".documents`)}
          (org_id, type, status, payment_status, number, number_int, year_of_issue,
           issuer_profile_id, counterparty_contact_id, counterparty_name, currency,
           grand_total_minor, issued_at)
         VALUES (${ORG}, 'invoice', 'issued', 'unpaid',
           ${`INV-2026-100${i}`}, ${i}, 2026, ${ISSUER}, ${CONTACT}, ${"Acme SAS"},
           'EUR', ${1000 * i}, ${`2026-05-1${i}`})`,
      )
    }
  })

  installHostBackedByRealHandler()
})

afterAll(async () => {
  await withSystemDb("reg-ds-shape-teardown", async (tx) => {
    await tx.execute(drizzleSql.raw(`DROP SCHEMA IF EXISTS "${INV}" CASCADE`))
  })
  // Restore SCHEMA_PREFIX so a flat multi-file run isn't poisoned (see beforeAll).
  if (priorSchemaPrefix === undefined) delete process.env.SCHEMA_PREFIX
  else
    process.env.SCHEMA_PREFIX = priorSchemaPrefix
    // biome-ignore lint/suspicious/noExplicitAny: clear the global host slot.
  ;(globalThis as any).__liaisonHost = undefined
  // biome-ignore lint/suspicious/noExplicitAny: clear the bound app name.
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
  // NOTE: deliberately do NOT close the shared privileged DB client here. This
  // file may run inside a flat multi-file `bun test` process (Strobe's bun
  // adapter), where ending the singleton connection would poison every
  // subsequent test file with CONNECTION_ENDED. The connection is torn down
  // once by the orchestrator's process exit.
})

describe("invoicing documents_search shape — UI consumers read the bare array (real DB + real bridge)", () => {
  it("the real handler returns a bare DocumentHeader[] (the route/api-client contract), not an { items } envelope", async () => {
    const result = await documentsSearchHandler({ type: "invoice" }, realCtx)
    expect(Array.isArray(result)).toBe(true)
    expect((result as unknown[]).length).toBe(3)
    // Guard the contract the UI fix depends on: there is no `.items` envelope.
    expect((result as unknown as { items?: unknown }).items).toBeUndefined()
  })

  it("dashboards loader searchDocuments() surfaces all 3 issued invoices (was empty when it read .items)", async () => {
    const rows = await searchDocuments({ type: "invoice" })
    expect(rows.length).toBe(3)
    expect(rows.map((r) => r.number).sort()).toEqual([
      "INV-2026-1001",
      "INV-2026-1002",
      "INV-2026-1003",
    ])
  })
})
