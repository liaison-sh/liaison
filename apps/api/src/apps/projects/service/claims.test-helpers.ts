// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A small world for the claims tests: an org with its owner, a project with done tasks, stored
// reconciliations with lines, and invoicing documents that carry a reconciliation's key. Rows go
// in through the seed factories; the code under test runs under the owner's own rows.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { seedContext } from "~/seed/context"
import {
  computeDocuments,
  type InvoicingDocumentSpec,
  seedInvoicingHistory,
} from "~/seed/factories/commerce/invoicing"
import { seedProject } from "~/seed/factories/projects/projects"
import {
  seedBillingClaim,
  seedReconciliation,
  seedReconciliationLine,
} from "~/seed/factories/projects/reconcile"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

export interface ClaimsWorld {
  orgId: string
  owner: minimal.Session
  projectId: string
  /** Task ids by key. */
  tasks: Record<string, string>
  threadId: string
}

const CLIENT = {
  key: "client",
  name: "Maison Delorme",
  email: "billing@delorme.example",
  country: "FR",
  vatId: "FR40303265045",
  address: "4 rue des Lilas, 69001 Lyon",
}
const ISSUER = {
  key: "studio",
  legalName: "Studio Issuer SAS",
  country: "FR",
  vatId: "FR60902000009",
  address: "2 rue Test, 75001 Paris",
  iban: "FR7630006000011234567890189",
  swiftBic: "AGRIFRPP",
  bankName: "Banque Test",
  defaultCurrency: "EUR",
  prefixes: { invoice: "F", quote: "D", proforma: "P", po: "BC", creditNote: "A" },
  shopifyShopId: null,
  invoiceApprovalThresholdMinor: "0",
  poApprovalThresholdMinor: "0",
  timezone: "Europe/Paris",
}

export function actorOf(w: ClaimsWorld, scopes: string[] = ["*"], userId = w.owner.userId) {
  return {
    actorType: "user",
    userId,
    orgId: w.orgId,
    scopes,
    dimensionGrants: { "*": ["*"] },
  } as UserContext
}

/** Run `fn` under a person's own rows (the owner, every scope, by default). */
export function asPerson<T>(
  w: ClaimsWorld,
  fn: (tx: RlsClient) => Promise<T>,
  opts: { scopes?: string[]; userId?: string } = {},
): Promise<T> {
  return withRlsContext(actorOf(w, opts.scopes, opts.userId), fn)
}

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")

/** The invoicing app registered for the org from source, so its documents table exists. */
async function registerInvoicing(orgId: string): Promise<void> {
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  await ensureAppsForOrg(orgId)
  await registerApps(
    [
      {
        ...manifest,
        trusted: false,
        _format: "manifest",
        _bundlePath: join(
          REPO_ROOT,
          "bundled-apps",
          "invoicing",
          String(manifest.version),
          "bundle.js",
        ),
      } as never,
    ],
    orgId,
  )
  await primeOrgApps(orgId, 0)
}

/** Forget the org's registered apps at the end of a file. */
export function forgetClaimsWorld(w: ClaimsWorld): void {
  forgetOrgApps(w.orgId)
}

/** An org, its owner, a project keyed `key` with done tasks `<key>-1` to `<key>-n`. */
export async function claimsWorld(key: string, taskCount = 6): Promise<ClaimsWorld> {
  const orgId = (await createTestOrg()).id
  const owner = await minimal.adminSession(orgId)
  await registerInvoicing(orgId)
  const ctx = seedContext({ orgId, now: new Date() })
  const ownerActor = {
    actorType: "user",
    userId: owner.userId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  } as UserContext
  const specTasks = Array.from({ length: taskCount }, (_, i) => ({
    key: `${key}-${i + 1}`,
    title: `Work item ${i + 1}`,
    status: "done" as const,
    ...(i === 0 ? { isMilestone: true } : {}),
  }))
  const made = await seedProject(ctx, ownerActor, {
    people: { owner: { userId: owner.userId } },
    spec: {
      key,
      name: `Maison Delorme ${key.toLowerCase()}`,
      description: "Client work.",
      icon: "folder",
      owner: "owner",
      tasks: specTasks,
    },
    externalRefOf: (k) => `claims-test:${orgId}:${k}`,
  })
  const tasks: Record<string, string> = {}
  specTasks.forEach((t, i) => {
    tasks[t.key] = made.taskIds[i]!
  })
  const threadId = await minimal.agentDm(orgId, owner.userId)
  return { orgId, owner, projectId: made.projectId, tasks, threadId }
}

/**
 * A stored reconciliation and its lines (`[taskKeys, billMinutes]`), proposed by default, in
 * `month`. Answers its id and its line ids in order.
 */
export async function storedReconciliation(
  w: ClaimsWorld,
  input: {
    month: string
    lines: Array<{
      tasks: string[]
      bill: number
      proofs?: Array<{ kind: string; ref: string; label: string }>
    }>
    state?: "proposed" | "drafted" | "invoiced" | "credited"
    basis?: string
    documentRef?: string
    createdBy?: string
    idleDays?: number
  },
): Promise<{ id: string; lineIds: string[] }> {
  const id = await seedReconciliation(w.orgId, {
    now: new Date(),
    projectId: w.projectId,
    createdBy: input.createdBy ?? w.owner.userId,
    threadId: w.threadId,
    state: input.state ?? "proposed",
    month: input.month,
    idleDays: input.idleDays ?? 0,
    ...(input.basis ? { basis: input.basis } : {}),
    ...(input.documentRef ? { documentRef: input.documentRef } : {}),
  })
  const lineIds: string[] = []
  let position = 0
  for (const l of input.lines) {
    lineIds.push(
      await seedReconciliationLine(w.orgId, {
        reconciliationId: id,
        position: position++,
        name: `Line ${position}`,
        taskIds: l.tasks.map((k) => w.tasks[k]!),
        billMinutes: l.bill,
        ...(l.proofs ? { proofs: l.proofs } : {}),
      }),
    )
  }
  return { id, lineIds }
}

/** A reserved claim on a task, made `ageMinutes` ago, held by a reconciliation. */
export function heldClaim(
  w: ClaimsWorld,
  taskKey: string,
  reconciliationId: string,
  ageMinutes: number,
  periodKey = "all",
  state: "reserved" | "left_off" = "reserved",
): Promise<string> {
  return seedBillingClaim(w.orgId, {
    now: new Date(),
    projectId: w.projectId,
    sourceRef: w.tasks[taskKey]!,
    periodKey,
    state,
    ageMinutes,
    reconciliationId,
  })
}

let docSeq = 0

/**
 * Invoicing documents of the org: an invoice (issued, or a draft) carrying `externalRef`, and
 * optionally a credit note taking back `creditMinor` of it. Answers the invoice's id and number.
 */
export async function invoiceCarrying(
  w: ClaimsWorld,
  input: { externalRef: string; status: "issued" | "draft"; minor?: number; creditMinor?: number },
): Promise<{ id: string; number: string | null }> {
  const ctx = seedContext({ orgId: w.orgId, now: new Date() })
  const key = `claims-doc-${++docSeq}`
  const minor = input.minor ?? 100_000
  const docs: InvoicingDocumentSpec[] = [
    {
      key,
      type: "invoice",
      status: input.status,
      paymentStatus: "unpaid",
      party: CLIENT.key,
      lines: [
        { description: "Studio work", unitPriceMinor: minor, quantity: 1, lineKind: "software" },
      ],
      issuedDaysAgo: input.status === "issued" ? 1 : null,
      externalRef: input.externalRef,
      billingProjectId: w.projectId,
    } as InvoicingDocumentSpec,
  ]
  if (input.creditMinor) {
    docs.push({
      key: `${key}-credit`,
      type: "credit_note",
      status: "issued",
      paymentStatus: "unpaid",
      party: CLIENT.key,
      lines: [
        {
          description: "Studio work taken back",
          unitPriceMinor: input.creditMinor,
          quantity: 1,
          lineKind: "software",
        },
      ],
      issuedDaysAgo: 0,
      correctsKey: key,
    } as InvoicingDocumentSpec)
  }
  await seedInvoicingHistory(ctx, {
    issuer: ISSUER,
    hsCodes: [],
    relationships: [],
    // Each call numbers from 1: shift its numbers past every earlier call's.
    documents: computeDocuments(ctx, {
      documents: docs,
      parties: new Map([[CLIENT.key, CLIENT]]),
      skus: new Map(),
    }).map((d) => {
      if (d.numberInt === null || d.number === null) return d
      const numberInt = d.numberInt + docSeq * 10
      return {
        ...d,
        numberInt,
        number: d.number.replace(/\d{4}$/, String(numberInt).padStart(4, "0")),
      }
    }),
    contactIdsByPartyKey: {},
  })
  const row = extractRows<{ id: string; number: string | null }>(
    await db.execute(drizzleSql`
      SELECT id::text AS id, number FROM app_invoicing.documents
       WHERE org_id = ${w.orgId}::uuid AND external_ref = ${input.externalRef}`),
  )[0]
  if (!row) throw new Error(`no document carries ${input.externalRef}`)
  return row
}

/** A claim's state, by id. */
export async function claimState(id: string): Promise<string | undefined> {
  return extractRows<{ state: string }>(
    await db.execute(
      drizzleSql`SELECT state FROM app_projects.billing_claims WHERE id = ${id}::uuid`,
    ),
  )[0]?.state
}

/** The claims of a reconciliation: state and document number, by source. */
export async function claimsOf(
  reconciliationId: string,
): Promise<Array<{ source_ref: string; state: string; document_number: string | null }>> {
  return extractRows(
    await db.execute(drizzleSql`
      SELECT source_ref, state, document_number FROM app_projects.billing_claims
       WHERE reconciliation_id = ${reconciliationId}::uuid ORDER BY source_ref, state`),
  )
}

/** A reconciliation's state and when it was last touched, or undefined once deleted. */
export async function reconciliationRow(
  id: string,
): Promise<{ state: string; fresh: boolean; document_ref: string | null } | undefined> {
  return extractRows<{ state: string; fresh: boolean; document_ref: string | null }>(
    await db.execute(drizzleSql`
      SELECT state, updated_at > now() - interval '5 minutes' AS fresh, document_ref
        FROM app_projects.reconciliations WHERE id = ${id}::uuid`),
  )[0]
}
