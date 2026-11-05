// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The provider binding of a contract: which installed app serves `<contract>@<version>` for a
// calling app in an org. It lives in the kernel (`organizations.settings.contractBindings`, keyed
// contract → caller app → provider app), where no app can write it: app code reaches only its own
// schema and the bridges (the strict `PATCH /org` settings schema does not accept the key either).
// It is written by an organisation administrator through two kernel paths, each audited:
//   - the operator's config apply (provisioner, privileged),
//   - the `contracts_setBinding` bridge, which accepts only a person holding `kernel:org:admin`
//     acting through their own UI click or an approval they requested.
// A binding names the caller explicitly, so an app that merely declares `contract_calls` is never
// bound to anything until an administrator binds it.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

const APP_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/

/** The provider bound for `callerApp` and `contract` in `orgId`, or null. */
export async function readKernelContractBinding(
  orgId: string,
  contract: string,
  callerApp: string,
): Promise<string | null> {
  const KS = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withPrivilegedDb(orgId, "contract-binding-read", async (db) =>
    extractRows<{ v: string | null }>(
      await db.execute(
        drizzleSql`SELECT settings->'contractBindings'->${contract}->>${callerApp} AS v
          FROM ${KS}.organizations WHERE id = ${orgId} LIMIT 1`,
      ),
    ),
  )
  const v = rows[0]?.v
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

/** Providers this caller was bound to before (for reads of work pinned to them), never the current one. */
export async function readKernelContractBindingHistory(
  orgId: string,
  contract: string,
  callerApp: string,
): Promise<string[]> {
  const KS = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withPrivilegedDb(orgId, "contract-binding-history-read", async (db) =>
    extractRows<{ v: unknown }>(
      await db.execute(
        drizzleSql`SELECT settings->'contractBindingHistory'->${contract}->${callerApp} AS v
          FROM ${KS}.organizations WHERE id = ${orgId} LIMIT 1`,
      ),
    ),
  )
  const v = rows[0]?.v
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

type Tx = { execute(q: ReturnType<typeof drizzleSql>): Promise<unknown> }

/**
 * Write (or clear, `provider: null`) the binding inside the caller's transaction, with an audit
 * row. The caller has already established that an administrator is acting. Returns the previous
 * value.
 */
export async function writeKernelContractBinding(
  tx: Tx,
  args: {
    orgId: string
    contract: string
    callerApp: string
    provider: string | null
    actorId: string | null
    actorType: "user" | "system"
    source: string
  },
): Promise<{ previous: string | null; changed: boolean }> {
  if (!APP_NAME_RE.test(args.callerApp)) throw new Error("invalid caller app name")
  if (args.provider !== null && !APP_NAME_RE.test(args.provider))
    throw new Error("invalid provider app name")
  const KS = drizzleSql.raw(schemaRef("kernel"))
  const before = extractRows<{ v: string | null }>(
    await tx.execute(
      drizzleSql`SELECT settings->'contractBindings'->${args.contract}->>${args.callerApp} AS v
        FROM ${KS}.organizations WHERE id = ${args.orgId} FOR UPDATE`,
    ),
  )
  const previous = before[0]?.v ?? null
  if (previous === args.provider) return { previous, changed: false }
  // Remember every provider this caller was bound to: work it approved through one of them
  // (a transmission pinned to it) can still be READ through it after a switch.
  if (previous !== null) {
    const histPath = `{contractBindingHistory,${args.contract},${args.callerApp}}`
    await tx.execute(
      drizzleSql`UPDATE ${KS}.organizations
        SET settings = jsonb_set(
              jsonb_set(
                jsonb_set(COALESCE(settings, '{}'::jsonb), '{contractBindingHistory}', COALESCE(settings->'contractBindingHistory', '{}'::jsonb), true),
                ${`{contractBindingHistory,${args.contract}}`}::text[],
                COALESCE(settings->'contractBindingHistory'->${args.contract}, '{}'::jsonb), true),
              ${histPath}::text[],
              (SELECT to_jsonb(array_agg(DISTINCT x)) FROM (
                 SELECT jsonb_array_elements_text(COALESCE(settings->'contractBindingHistory'->${args.contract}->${args.callerApp}, '[]'::jsonb)) AS x
                 UNION SELECT ${previous}::text) u),
              true)
        WHERE id = ${args.orgId}`,
    )
  }
  const path = `{contractBindings,${args.contract},${args.callerApp}}`
  if (args.provider === null) {
    await tx.execute(
      drizzleSql`UPDATE ${KS}.organizations SET settings = settings #- ${path}::text[], updated_at = now() WHERE id = ${args.orgId}`,
    )
  } else {
    // jsonb_set does not create missing intermediate objects: build them first.
    await tx.execute(
      drizzleSql`UPDATE ${KS}.organizations
        SET settings = jsonb_set(
              jsonb_set(
                jsonb_set(COALESCE(settings, '{}'::jsonb), '{contractBindings}', COALESCE(settings->'contractBindings', '{}'::jsonb), true),
                ${`{contractBindings,${args.contract}}`}::text[],
                COALESCE(settings->'contractBindings'->${args.contract}, '{}'::jsonb), true),
              ${path}::text[], to_jsonb(${args.provider}::text), true),
            updated_at = now()
        WHERE id = ${args.orgId}`,
    )
  }
  const { writeAuditLog } = await import("~/modules/audit/service")
  await writeAuditLog(
    tx as never,
    {
      orgId: args.orgId,
      actorId: args.actorId,
      actorType: args.actorType,
      app: "kernel",
      entityType: "contract_binding",
      entityId: args.orgId,
      action: "contract.binding_changed",
      changes: { [`${args.contract}:${args.callerApp}`]: { from: previous, to: args.provider } },
      metadata: { source: args.source, contract: args.contract, caller: args.callerApp },
    } as never,
  )
  return { previous, changed: true }
}
