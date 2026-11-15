// SPDX-License-Identifier: FSL-1.1-ALv2
// Create invoice and Undo on a reconcile card: the projects half of the steps. The handler runs
// them in order around invoicing's own calls (preview, draft, discard), each step in its own
// short transaction under the caller's row security:
//
//   facts    what invoicing prices the card from (no check, no write)
//   prepare  checks the card (state, revision, basis) and reads what invoicing needs
//   reserve  reserves the card's sources and freezes the rate, currency and hours in a day
//   finish   marks the card drafted on the draft invoicing made, and draws the card
//   release  frees the reservation when no document carries the card's key (a failed draft)
//
// and for Undo, `undo_prepare` then `undo_finish`. No number is taken anywhere here: invoicing
// makes a draft, and a person issues it.
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { reconcileMark, releaseReconciliation, reserveClaims, SUPERSEDED } from "./claims"
import { draftTitle, reconciliationHead, storedCard } from "./reconcile"
import { documentsForRef } from "./reconcile-sweep"
import { retainerDocumentRef, retainerMonthFacts } from "./retainer-month"
import { ProjectsServiceError } from "./statuses"
import { datedHoursOn, hoursPerDayMinutes } from "./time-plan"

type Tx = RlsClient

/** The key the card's draft carries: one draft per card revision. */
export function reconcileDocumentRef(reconciliationId: string, revision: number): string {
  return `reconcile:${reconciliationId}:${revision}`
}

export type CreateStep = "facts" | "prepare" | "reserve" | "finish" | "release"
export type UndoStep = "undo_prepare" | "undo_finish"

interface StepArgs {
  tx: Tx
  orgId: string
  userId: string
  scopes: readonly string[]
  origin?: string
  now?: Date
  input: Record<string, unknown>
}

const idOf = (input: Record<string, unknown>) => String(input.reconciliationId ?? "").trim()

/** A card past its draft says what to do instead of creating again. */
function alreadyIssued(projectName: string, state: string): ProjectsServiceError {
  return new ProjectsServiceError(
    409,
    "already_issued",
    `The card of ${projectName} is already ${state === "credited" ? "credited" : "invoiced"}: its lines are locked. Nothing was created or undone.`,
    { state, next: "To change what was billed, offer a credit note on the invoice." },
  )
}

async function projectFacts(tx: Tx, orgId: string, projectId: string) {
  const row = extractRows<{
    name: string
    company_id: string | null
    lead_name: string | null
    rate: string | number | null
    currency: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT p.name, p.company_id::text AS company_id, u.name AS lead_name,
             bt.rate_minor AS rate, bt.currency
        FROM ${projectsRel("projects")} p
        LEFT JOIN ${kernelRel("users")} u ON u.id = p.owner_id AND u.org_id = p.org_id
        LEFT JOIN ${projectsRel("project_billing_terms")} bt
          ON bt.project_id = p.id AND bt.org_id = p.org_id
       WHERE p.id = ${projectId}::uuid AND p.org_id = ${orgId}::uuid`),
  )[0]
  return {
    name: row?.name ?? "the project",
    companyId: row?.company_id ?? null,
    leadName: row?.lead_name ?? null,
    rateMinor: row?.rate === null || row?.rate === undefined ? null : Number(row.rate),
    currency: row?.currency ?? null,
  }
}

async function billedLines(tx: Tx, orgId: string, id: string) {
  return extractRows<{ id: string; bill_minutes: number }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, bill_minutes FROM ${projectsRel("reconciliation_lines")}
       WHERE reconciliation_id = ${id}::uuid AND org_id = ${orgId}::uuid AND bill_minutes > 0
       ORDER BY position`),
  )
}

/** One step of Create invoice, as the handler calls it through the bridge. */
export async function reconcileCreateStep(args: StepArgs & { step: CreateStep }) {
  const { tx, orgId, userId, input } = args
  const id = idOf(input)
  const revision = Number(input.revision)
  const head = await reconciliationHead(tx, orgId, id)
  const facts = await projectFacts(tx, orgId, head.project_id)
  // A retainer month's draft is keyed by its schedule and month; any other card by its revision.
  const retainer =
    head.basis === "retainer" && head.period_start
      ? await retainerMonthFacts(tx, orgId, head.project_id, head.period_start)
      : null
  const key =
    retainer?.scheduleId && head.period_start
      ? retainerDocumentRef(retainer.scheduleId, head.period_start)
      : reconcileDocumentRef(head.id, revision)
  const retainerFields = retainer
    ? { periodFrom: head.period_start, timeboxMinutes: retainer.timeboxMinutes }
    : {}

  // What invoicing prices a card from, read under the reader's own rows: no check, no write.
  if (args.step === "facts") {
    const lines = await billedLines(tx, orgId, head.id)
    return {
      projectId: head.project_id,
      basis: head.basis,
      companyId: facts.companyId,
      currency: facts.currency,
      rateMinor: facts.rateMinor,
      hoursPerDayMinutes: await hoursPerDayMinutes(tx, orgId),
      lines: lines.map((l) => ({ billMinutes: l.bill_minutes })),
      ...retainerFields,
    }
  }

  if (args.step === "prepare") {
    // A card is billed from Liaison, one click on it: never from a coding agent's terminal.
    if (args.origin === "mcp") {
      throw new ProjectsServiceError(
        409,
        "create_on_card",
        `The invoice of ${facts.name} is created from its card in Liaison, not from here. Nothing was created.`,
        {
          next: "Open the card in Liaison (reconcile_get shows it) and press Create invoice there.",
        },
      )
    }
    if (head.state === "invoiced" || head.state === "credited") {
      throw alreadyIssued(facts.name, head.state)
    }
    if (!Number.isInteger(revision) || revision !== head.revision) {
      const latest = await storedCard({
        tx,
        orgId,
        userId,
        scopes: args.scopes,
        reconciliationId: head.id,
        said: `The card moved on to revision ${head.revision}.`,
        ...(args.now ? { now: args.now } : {}),
      })
      throw new ProjectsServiceError(
        409,
        "card_changed",
        `This card moved on to revision ${head.revision} since it was drawn. Nothing was created.`,
        { latest: latest.card, next: "Show the latest card; Create invoice is pressed on it." },
      )
    }
    if (head.basis === "fixed" || head.basis === "none") {
      throw new ProjectsServiceError(
        409,
        "basis_not_billable",
        `${facts.name} is not billed from planned vs done (${head.basis === "fixed" ? "it has a fixed price" : "it has no billing basis"}). Nothing was created.`,
        { next: "A fixed price or a billing plan is invoiced from its milestones." },
      )
    }
    if (head.basis === "retainer" && !retainer?.scheduleId) {
      throw new ProjectsServiceError(
        409,
        "no_retainer_schedule",
        `${facts.name} is billed by a monthly retainer, but this month has no retainer timebox from a recurring schedule, so nothing was created.`,
        {
          next: "Save the retainer on its recurring schedule in Invoicing, then press Create invoice again.",
        },
      )
    }
    // A contact named for the invoice belongs to the project's own company, or nothing is made.
    const contactId = typeof input.contactId === "string" ? input.contactId.trim() : ""
    if (contactId) {
      const contact = extractRows<{ company_id: string | null }>(
        await tx.execute(drizzleSql`
          SELECT company_id::text AS company_id FROM ${kernelRel("contacts")}
           WHERE org_id = ${orgId}::uuid AND id::text = ${contactId}`),
      )[0]
      if (!contact || !facts.companyId || contact.company_id !== facts.companyId) {
        throw new ProjectsServiceError(
          409,
          "counterparty_mismatch",
          `The contact named is not one of ${facts.name}'s own company, so the invoice would go to another customer. Nothing was created.`,
          { next: "Name a contact of the project's company, or none." },
        )
      }
    }
    const lines = await billedLines(tx, orgId, head.id)
    return {
      reconciliationId: head.id,
      revision: head.revision,
      state: head.state,
      documentRef: key,
      projectId: head.project_id,
      projectName: facts.name,
      companyId: facts.companyId,
      basis: head.basis,
      rateMinor: facts.rateMinor,
      currency: facts.currency,
      hoursPerDayMinutes: await hoursPerDayMinutes(tx, orgId),
      leadName: facts.leadName,
      // A project with dated hours files the month's timesheet on the draft.
      datedHours: await datedHoursOn(tx, orgId, head.project_id),
      month: head.period_start ? head.period_start.slice(0, 7) : null,
      lines: lines.map((l) => ({ billMinutes: l.bill_minutes })),
      ...retainerFields,
    }
  }

  if (args.step === "reserve") {
    if (head.state === "invoiced" || head.state === "credited") {
      throw alreadyIssued(facts.name, head.state)
    }
    if (revision !== head.revision) {
      throw new ProjectsServiceError(
        409,
        "card_changed",
        `This card moved on to revision ${head.revision} since it was drawn. Nothing was reserved.`,
      )
    }
    return reserveClaims(tx, {
      orgId,
      reconciliationId: head.id,
      documentRef: key,
      terms: {
        rateMinor: facts.rateMinor,
        currency: facts.currency,
        hoursPerDayMinutes: await hoursPerDayMinutes(tx, orgId),
      },
    })
  }

  if (args.step === "release") {
    // Released only when no document carries the card's key, in any state.
    const docs = await documentsForRef(orgId, key)
    if (docs.length > 0) return { released: 0, kept: true, state: head.state }
    if (head.state === "drafted") {
      const out = await releaseReconciliation(tx, { orgId, reconciliationId: head.id })
      return { ...out, kept: false }
    }
    const released = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("billing_claims")} SET state = 'released', updated_at = now()
         WHERE org_id = ${orgId}::uuid AND reconciliation_id = ${head.id}::uuid
           AND state IN ('reserved', 'left_off')
        RETURNING id::text AS id`),
    ).length
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("reconciliations")} SET document_ref = NULL, updated_at = now()
       WHERE id = ${head.id}::uuid AND org_id = ${orgId}::uuid AND state = 'proposed'
         AND document_ref = ${key}`)
    return { released, kept: false, state: head.state }
  }

  // finish: the card is on the draft invoicing made for this revision.
  const documentId = String(input.documentId ?? "")
  const moved = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("reconciliations")}
         SET state = 'drafted', document_id = ${documentId}::uuid,
             drafted_at = coalesce(drafted_at, now()),
             drafted_by = coalesce(drafted_by, ${userId}::uuid),
             waived_overage = ${input.waiveOverage === true}, updated_at = now()
       WHERE id = ${head.id}::uuid AND org_id = ${orgId}::uuid AND revision = ${revision}
         AND state IN ('proposed', 'drafted') AND document_ref = ${key}
      RETURNING id::text AS id`),
  )
  if (moved.length === 0) {
    throw new ProjectsServiceError(
      409,
      "card_changed",
      `The card of ${facts.name} changed while its draft was made. Its draft stays in Invoicing.`,
      { next: "Show the latest card; the draft can be discarded in Invoicing." },
    )
  }
  // Each billed line's place on the draft: the draft lists them in the card's order.
  const lines = await billedLines(tx, orgId, head.id)
  for (const [i, l] of lines.entries()) {
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("reconciliation_lines")} SET document_line_position = ${i + 1}
       WHERE id = ${l.id}::uuid AND org_id = ${orgId}::uuid
         AND document_line_position IS DISTINCT FROM ${i + 1}`)
  }
  const out = await storedCard({
    tx,
    orgId,
    userId,
    scopes: args.scopes,
    reconciliationId: head.id,
    said: "",
    ...(args.now ? { now: args.now } : {}),
  })
  return { ...out.card, documentId, title: draftTitle(out.card) }
}

/** One step of Undo on a card whose invoice is a draft. */
export async function reconcileUndoStep(args: StepArgs & { step: UndoStep }) {
  const { tx, orgId, userId, input } = args
  const head = await reconciliationHead(tx, orgId, idOf(input))
  const facts = await projectFacts(tx, orgId, head.project_id)
  if (head.state === "invoiced" || head.state === "credited") {
    throw alreadyIssued(facts.name, head.state)
  }
  const card = (said: string) =>
    storedCard({
      tx,
      orgId,
      userId,
      scopes: args.scopes,
      reconciliationId: head.id,
      said,
      ...(args.now ? { now: args.now } : {}),
    })
      .then((s) => s.card as Record<string, unknown>)
      .catch((err: unknown) => {
        // A project turned off since keeps its money moving (Undo still frees the claims), but it
        // has no card to draw any more: say what happened instead.
        if (!(err instanceof ProjectsServiceError) || err.code !== "planning_off") throw err
        return {
          reconciliationId: head.id,
          revision: head.revision,
          state: "proposed",
          title: facts.name,
          end: "",
          sub: `${facts.name} no longer uses time and budgets, so its card is not drawn again.`,
          fit: "",
          groups: [],
          cardNotes: [],
          tot: [],
          cover: null,
          notice: null,
          connectGithub: null,
          fixedPrice: null,
          editable: null,
          foot: null,
          createInvoice: null,
          summary: null,
          undo: null,
          locked: null,
          message: `${said} ${facts.name} no longer uses time and budgets, so its card is not drawn again.`,
        } as Record<string, unknown>
      })

  if (args.step === "undo_prepare") {
    if (head.state === "proposed") {
      return {
        undone: false,
        card: await card("It has no invoice draft, so there is nothing to undo."),
      }
    }
    return { undone: null, documentId: head.document_id, reconciliationId: head.id }
  }

  // undo_finish: the draft is gone; the card's month is free again (the discard asked for it
  // already; this repeat changes nothing then).
  const mark = await reconcileMark({
    tx,
    orgId,
    input: { reconciliationId: head.id, to: "released" },
  })
  if (mark.state === SUPERSEDED) {
    // A newer card of the same person and period stands: this one was set aside, so Undo shows
    // that card.
    const newer = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT o.id::text AS id FROM ${projectsRel("reconciliations")} o
          JOIN ${projectsRel("reconciliations")} r ON r.id = ${head.id}::uuid AND r.org_id = o.org_id
         WHERE o.org_id = ${orgId}::uuid AND o.project_id = r.project_id AND o.state = 'proposed'
           AND o.created_by = r.created_by AND o.id <> r.id
           AND o.period_start IS NOT DISTINCT FROM r.period_start
         LIMIT 1`),
    )[0]?.id
    if (newer) {
      const shown = await storedCard({
        tx,
        orgId,
        userId,
        scopes: args.scopes,
        reconciliationId: newer,
        said: "Undone: the invoice draft was discarded, no number was used, and every claim is free again. A newer card of this period stands; here it is.",
        ...(args.now ? { now: args.now } : {}),
      })
      return { undone: true, card: shown.card }
    }
    return {
      undone: true,
      card: await card(
        "Undone: the invoice draft was discarded, no number was used, and every claim is free again. A newer card of this period, by the person who made it, stands.",
      ),
    }
  }
  const again = await reconciliationHead(tx, orgId, head.id)
  if (again.state !== "proposed") {
    throw new ProjectsServiceError(409, "undo_incomplete", `${mark.message}`, {
      next: "Discard the draft in Invoicing, then reconcile the period again.",
    })
  }
  return {
    undone: true,
    card: await card(
      "Undone: the invoice draft was discarded, no number was used, and every claim is free again.",
    ),
  }
}
