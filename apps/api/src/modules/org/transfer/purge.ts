// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Removing a copy of an org a transfer no longer needs:
//   `incoming`  the target's copy of a move that was aborted (or an import
//               re-run), wired into the freeze resolver (setIncomingOrgPurge);
//   `moved`     the source's copy after the hold (`purge-source`), or the old
//               copy a reverse move replaces.
// Both go through the org purge (purge/purge-org.ts, catalog driven, residue
// verified), with the provider-side disconnect hooks OFF: a Shopify webhook
// subscription or a mailbox watch belongs to the copy that stays live. The
// guard re-reads the org row: it must hold exactly that state for exactly that
// transfer, so no other org, and no live org, can ever be purged here.
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { markOrgDeleting } from "~/modules/org/purge/deleting"
import type { OrgExternalStateDeps } from "~/modules/org/purge/external"
import { type PurgeOrgResult, purgeOrg } from "~/modules/org/purge/purge-org"
import { resultRows } from "~/modules/org/purge/rows"
import { setIncomingOrgPurge } from "~/modules/org/transfer-state/resolver"
import { buildClosure, orgPredicate, readCatalog, rel, type TransferSql } from "./closure"
import { assertIncomingPurgeSafe } from "./storage-identity"

const log = rootLogger.child({ module: "org-transfer-purge" })

export class TransferPurgeRefused extends Error {
  constructor(orgId: string, expected: string, transferId: string, found: string) {
    super(
      `org transfer purge: organization ${orgId} is ${found}, not ${expected} for transfer ${transferId}; nothing is deleted`,
    )
    this.name = "TransferPurgeRefused"
  }
}

async function readState(
  orgId: string,
): Promise<{ state: string | null; transferId: string | null } | null> {
  return withSystemDb("org-transfer-purge-read", async (tx) => {
    const r = resultRows<{ state: string | null; transfer_id: string | null }>(
      await tx.execute(
        drizzleSql`SELECT transfer_state AS state, transfer_id::text AS transfer_id
                     FROM ${drizzleSql.raw(schemaRef("kernel"))}.organizations WHERE id = ${orgId}::uuid`,
      ),
    )[0]
    return r ? { state: r.state, transferId: r.transfer_id } : null
  })
}

/** Purge the org's `incoming` or `moved` copy held by `transferId`. Re-runnable. */
export async function purgeTransferCopy(
  orgId: string,
  transferId: string,
  expected: "incoming" | "moved",
  opts: { externalDeps?: OrgExternalStateDeps } = {},
): Promise<PurgeOrgResult> {
  const guard = async (id: string) => {
    const now = await readState(id)
    if (!now) return
    if (now.state !== expected || now.transferId !== transferId) {
      throw new TransferPurgeRefused(
        id,
        expected,
        transferId,
        `${now.state ?? "active"}${now.transferId ? ` for transfer ${now.transferId}` : ""}`,
      )
    }
  }
  const before = await readState(orgId)
  if (before) {
    await guard(orgId)
    // The purge's legal-record exception needs the deletion started on the row.
    await markOrgDeleting(orgId)
  }
  // The purge sweeps tables with an org_id; the closure's other rows go by FK
  // cascade, except those linked without a foreign key (consumer marks). They
  // are deleted here first, deepest first, so no row of the copy is left.
  if (before) await deleteLinkedRows(orgId)
  const result = await purgeOrg(orgId, {
    reason: `org-transfer-purge-${expected}`,
    assertAllowed: guard,
    settle: false,
    providerHooks: false,
    ...(opts.externalDeps ? { externalDeps: opts.externalDeps } : {}),
  })
  log.warn({ orgId, transferId, expected }, "org transfer: copy purged")
  return result
}

async function deleteLinkedRows(orgId: string): Promise<void> {
  await withSystemDb("org-transfer-purge-linked", async (tx) => {
    const sql: TransferSql = {
      unsafe: (text: string) => tx.execute(drizzleSql.raw(text)) as never,
    }
    const closure = buildClosure(await readCatalog(sql))
    for (const t of [...closure.tables].reverse()) {
      // A real foreign key cascades from its parent; only synthetic links do not.
      if (t.kind !== "via" || !t.parent?.name.startsWith("transfer:")) continue
      await tx.execute(
        drizzleSql.raw(
          `DELETE FROM ${rel(t.name)} t WHERE ${orgPredicate(closure, t, "t", orgId)}`,
        ),
      )
    }
  })
}

/** An aborted move's incoming copy, purged (the freeze resolver calls it per overdue org). */
async function purgeAbortedIncomingCopy(orgId: string, transferId: string): Promise<void> {
  await assertIncomingPurgeSafe(transferId)
  await purgeTransferCopy(orgId, transferId, "incoming")
}

/** Wire the freeze resolver's abort path: an aborted move's incoming copy is purged. */
export function wireIncomingOrgPurge(): void {
  setIncomingOrgPurge(purgeAbortedIncomingCopy)
}
