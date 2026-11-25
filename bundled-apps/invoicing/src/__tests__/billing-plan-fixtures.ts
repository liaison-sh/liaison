// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test only: a fixed-price project with a quote of 64,000.00 excl. VAT, planned as an advance of
// 12,800.00, three milestones and a final of 16,000.00 each, and projects' milestone read stubbed
// with what it returns (done state only).

import { invoiceIssue, type MutationsCtx } from "../mutations"
import { advanceDraftCreate } from "../mutations/advances"
import { billingPlanGet, billingPlanSet } from "../mutations/billing-plan"
import { createMockDb, type MockDb } from "../test-db"
import { testTime } from "../test-time"

type Row = Record<string, unknown>

export const ISSUER = {
  id: "iss-1",
  legal_name: "Maison Studio SAS",
  country: "FR",
  vat_id: "FR12345678901",
  address: "1 rue Test, 75001 Paris",
  default_currency: "EUR",
  default_language: "fr",
  prefix_invoice: "F-{YYYY}-",
  prefix_credit_note: "A-{YYYY}-",
  invoice_approval_threshold_minor: null,
  require_two_eyes: false,
}
export const PROJECT = "5b1d2c3e-0000-4000-8000-000000000001"
export const QUOTE = "5b1d2c3e-0000-4000-8000-0000000000d1"
export const T_ALPHA = "5b1d2c3e-0000-4000-8000-0000000000a1"
export const T_BETA = "5b1d2c3e-0000-4000-8000-0000000000a2"
export const T_GAMMA = "5b1d2c3e-0000-4000-8000-0000000000a3"
export const T_LAUNCH = "5b1d2c3e-0000-4000-8000-0000000000a4"

export const QUOTE_ROW: Row = {
  id: QUOTE,
  type: "quote",
  status: "accepted",
  number: "D-2026-0040",
  currency: "EUR",
  subtotal_minor: 6_400_000n,
  issuer_profile_id: "iss-1",
  counterparty_contact_id: null,
  counterparty_name: "Maison Rivage SA",
  counterparty_address: "4 quai Test, 69002 Lyon",
  counterparty_country: "FR",
  counterparty_email: "compta@rivage.example",
  counterparty_vat_id: null,
  billing_line1: "4 quai Test",
  billing_postcode: "69002",
  billing_city: "Lyon",
  billing_country_code: "FR",
  customer_kind: "individual",
}

export interface Task {
  id: string
  title: string
  terminal: boolean
  isMilestone: boolean
  completedOn: string | null
  // Fields projects knows and must never hand to invoicing through this read.
  assigneeId?: string
  realMinutes?: number
}

export interface Harness {
  ctx: MutationsCtx & { hasScope(s: string): Promise<boolean> }
  db: MockDb
  approvals: Array<Row & { id: string; status: string }>
  tasks: Map<string, Task>
  basis: { value: string }
  calls: Array<{ target: string; args: Row; result: unknown }>
}

export function harness(): Harness {
  const db = createMockDb({ seed: { issuer_profiles: [ISSUER], documents: [{ ...QUOTE_ROW }] } })
  const approvals: Harness["approvals"] = []
  const basis = { value: "fixed" }
  const calls: Harness["calls"] = []
  const tasks = new Map<string, Task>(
    [
      [T_ALPHA, "Alpha"],
      [T_BETA, "Beta"],
      [T_GAMMA, "Gamma"],
      [T_LAUNCH, "Launch"],
    ].map(([id, title]) => [
      id as string,
      {
        id: id as string,
        title: title as string,
        terminal: false,
        isMilestone: true,
        completedOn: null,
        assigneeId: "user-9",
        realMinutes: 600,
      },
    ]),
  )
  let seq = 0
  const ctx = {
    getUserId: async () => "user-1",
    approval: null,
    db,
    time: testTime(),
    pdf: {
      async render() {
        return {
          file_id: `pdf-${++seq}`,
          byte_size: 1,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: { post: async () => ({ message_id: `m-${++seq}` }) },
    hasScope: async () => true,
    requestApproval: async (input: Row) => {
      const id = crypto.randomUUID()
      approvals.push({ id, status: "pending", ...input })
      return { approval_id: id }
    },
    approvals: {
      pendingFor: async (key: string, tools?: string[]) =>
        approvals
          .filter((a) => a.status === "pending" && (!tools || tools.includes(String(a.tool_name))))
          .map((a) => ({
            id: a.id,
            tool_name: a.tool_name,
            target_id: (a.current_payload as Row)[key],
          })),
      withdraw: async (id: string) => {
        const a = approvals.find((x) => x.id === id)
        if (a) a.status = "cancelled"
        return { ok: true }
      },
    },
    decideApproval: async () => ({ status: "ok" }),
    executeTool: async (target: string, args: Row) => {
      let result: unknown = {}
      if (target === "projects:milestone_status_read") {
        // What projects' read returns: done state only, never a title, assignee or time.
        const ids = (args.taskIds as string[]) ?? []
        result = {
          basis: basis.value,
          tasks: ids
            .map((i) => tasks.get(i))
            .filter((t): t is Task => !!t)
            .map((t) => ({
              id: t.id,
              terminal: t.terminal,
              isMilestone: t.isMilestone,
              completedOn: t.completedOn,
            })),
        }
      }
      calls.push({ target, args, result })
      if (target.startsWith("stripe:"))
        return { status: "error" as const, error: { code: "tool_not_found", message: "absent" } }
      return { status: "completed" as const, result }
    },
    emit: async () => {},
  } as unknown as Harness["ctx"]
  return { ctx, db, approvals, tasks, basis, calls }
}

export const PLAN_STEPS = [
  { kind: "advance", label: "Advance 20%", amountMinor: 1_280_000 },
  { kind: "milestone", label: "Alpha", amountMinor: 1_600_000, taskId: T_ALPHA },
  { kind: "milestone", label: "Beta", amountMinor: 1_600_000, taskId: T_BETA },
  { kind: "milestone", label: "Gamma", amountMinor: 1_600_000, taskId: T_GAMMA },
  { kind: "final", label: "Launch", amountMinor: 1_600_000, taskId: T_LAUNCH },
]

export async function withPlan(h: Harness) {
  const res = await billingPlanSet(h.ctx, {
    projectId: PROJECT,
    quoteDocumentId: QUOTE,
    steps: PLAN_STEPS,
  })
  if (res.status !== "completed") throw new Error(JSON.stringify(res))
  return res
}

export function done(h: Harness, taskId: string, on = "2026-06-12") {
  const t = h.tasks.get(taskId) as Task
  t.terminal = true
  t.completedOn = on
}

/** Draft and issue the plan's advance (the normal series), as a person would. */
export async function issuedAdvance(h: Harness): Promise<Row> {
  const plan = await billingPlanGet(h.ctx, { projectId: PROJECT })
  if (plan.status !== "completed") throw new Error("no plan")
  const step = plan.steps.find((s) => s.kind === "advance") as { id: string }
  const d = await advanceDraftCreate(h.ctx, { projectId: PROJECT, stepId: step.id })
  if (d.status !== "completed") throw new Error(JSON.stringify(d))
  const issued = await invoiceIssue(h.ctx, { draft_id: d.draftId })
  if ((issued as { status?: string }).status !== "completed")
    throw new Error(JSON.stringify(issued))
  const id = (issued as { document_id: string }).document_id
  return h.db.__all("documents").find((r) => r.id === id) as Row
}
