// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month-end run inside its approval card, rendered: rows open where they are with the
// document editor's own fields, the total follows what is typed, a changed run says what changed
// and who changed it, and each viewer sees the controls their rights give.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const calls: Array<{ tool: string; params: Record<string, unknown> }> = []
const decided: unknown[] = []
const mounted: Array<Record<string, unknown>> = []
let rows: Array<Record<string, unknown>> = []

const row = (id: string, customer: string, total: string, extra: Record<string, unknown> = {}) => ({
  item_id: id,
  draft_id: `doc-${id}`,
  document_id: `doc-${id}`,
  state: "ready",
  customer,
  account_manager: null,
  net_minor: String(BigInt(total) * 5n / 6n),
  vat_minor: String(BigInt(total) / 6n),
  total_minor: total,
  currency: "EUR",
  number: null,
  updated_at: "2026-11-27T07:00:00.000Z",
  latest_change: null,
  flags: ["Same as October"],
  failure: null,
  ...extra,
})

const RETAINER = ["Retainer"][0]

const draftDoc = (id: string) => ({
  id: `doc-${id}`,
  type: "invoice",
  status: "draft",
  currency: "EUR",
  language: "en",
  incoterm: "EXW",
  issuer_profile_id: "iss-1",
  issuer_country: "FR",
  counterparty_name: "Hôtels Belcour",
  counterparty_email: "billing@belcour.example",
  counterparty_address: "1 rue de Test, 75011 Paris",
  counterparty_country: "FR",
  due_at: "2026-12-30",
  tax_treatment: "domestic",
  lines: [{ position: 1, description: RETAINER, quantity: "1", unit_price_minor: "49000", tax_rate_bp: 2000 }],
})

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  navigate: () => {},
  onEntityChange: () => () => {},
  fetch: async (path: string) => {
    if (path.includes("u-elodie")) return { data: { name: "Élodie Renard" } }
    if (path.includes("u-sara")) return { data: { name: "Sara Benali" } }
    throw new Error("unknown")
  },
  app: {
    createResource,
    decideApproval: async (...args: unknown[]) => {
      decided.push(args)
      return { ok: true }
    },
    mountEntityDiscussion: (_anchor: unknown, descriptor: Record<string, unknown>) => {
      mounted.push(descriptor)
      return { resolved: true, dispose: () => {} }
    },
    invokeTool: async (tool: string, params: Record<string, unknown>) => {
      calls.push({ tool, params })
      if (tool === "recurring_run_get") {
        return { status: "completed", run: { id: "run-1", issue_on: "2026-11-30", period: "November 2026", status: "drafted" }, rows }
      }
      if (tool === "documents_get") return { ...draftDoc(String(params.id).replace("doc-", "")), lines: draftDoc("x").lines }
      if (tool === "settings_issuer_profile_list") {
        return { items: [{ id: "iss-1", legal_name: "Issuer", country: "FR", is_default: true, today: "2026-11-27" }] }
      }
      return { status: "completed" }
    },
  },
}))

const { MonthEndRunPanel } = await import("./MonthEndRunPanel")
const { Editor } = await import("./Editor")

const item = (id: string, hash: string, total: string) => ({ item_id: id, document_id: `doc-${id}`, content_hash: hash, total_minor: total })
const WRITE = ["invoicing:documents:write", "invoicing:documents:read"]

function renderPanel(opts: { items?: ReturnType<typeof item>[]; scopes?: string[]; canDecide?: boolean } = {}) {
  const items = opts.items ?? rows.map((r) => item(String(r.item_id), `h-${r.item_id}`, String(r.total_minor)))
  return render(() => (
    <MonthEndRunPanel
      approvalId="appr-1"
      status="pending"
      payload={{ run_id: "run-1", items }}
      payloadHash="hash-1"
      canDecide={opts.canDecide ?? true}
      viewerScopes={opts.scopes ?? WRITE}
    />
  ))
}

/** The open row's price cell, once the editor has read the issuer (which may restate the lines). */
async function editorReady(): Promise<HTMLElement> {
  await waitFor(() => expect(calls.some((c) => c.tool === "settings_issuer_profile_list")).toBe(true))
  await new Promise((r) => setTimeout(r, 50))
  return screen.getByTestId("editor-line-1-unit-price")
}

const fieldIds = (root: HTMLElement) =>
  [...root.querySelectorAll("[data-testid]")]
    .map((e) => e.getAttribute("data-testid") ?? "")
    .filter((id) => id.startsWith("editor-field-") || /^editor-line-\d+-(description|quantity|unit-price)$/.test(id))

describe("the month-end panel", () => {
  beforeEach(() => {
    calls.length = 0
    decided.length = 0
    mounted.length = 0
    rows = [row("a", "Hôtels Belcour", "58800", { account_manager: "u-elodie" }), row("b", "Le Comptoir Sud", "58800")]
  })
  afterEach(cleanup)

  it("a row opens in place with the editor's own field list and validation", async () => {
    renderPanel()
    fireEvent.click(await screen.findByTestId("month-end-row-open-a"))
    const open = await screen.findByTestId("month-end-row-editor-a")
    await waitFor(() => expect(within(open).getByTestId("editor-field-customer-name")).toBeTruthy())
    const compact = fieldIds(open)
    cleanup()
    const full = render(() => <Editor initial={draftDoc("a") as never} documentId="doc-a" />)
    const all = fieldIds(full.container as HTMLElement)
    // No second field set: every field the row shows is the editor's own.
    expect(compact.length).toBeGreaterThan(5)
    for (const id of compact) expect(all).toContain(id)
    for (const id of ["editor-field-customer-name", "editor-field-due-at", "editor-line-1-quantity", "editor-line-1-unit-price"]) {
      expect(compact).toContain(id)
    }
    // Issue buttons and the summary stay in the full editor only.
    expect(compact).not.toContain("editor-field-type")
  })

  it("typing recomputes the row, the total and Approve N before saving, and saving sends what was shown", async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("month-end-approve-count").textContent).toContain("2 invoices to approve"))
    fireEvent.click(await screen.findByTestId("month-end-row-open-a"))
    const price = await editorReady()
    fireEvent.input(price, { target: { value: "650" } })
    await waitFor(() => expect(screen.getByTestId("month-end-row-unsaved-a").textContent).toContain("780"))
    expect(screen.getByTestId("month-end-row-total-a").textContent).toContain("780")
    // 780.00 + 588.00, still two rows to approve.
    expect(screen.getByTestId("month-end-approve-count").textContent).toMatch(/2 invoices to approve, .*1[,.  ]?368/)
    fireEvent.click(screen.getByTestId("month-end-row-save-month"))
    await waitFor(() => expect(calls.some((c) => c.tool === "drafts_update")).toBe(true))
    const sent = calls.find((c) => c.tool === "drafts_update")?.params as Record<string, unknown>
    expect(sent).toMatchObject({ draft_id: "doc-a", applies: "this_month", if_unchanged_since: "2026-11-27T07:00:00.000Z" })
    expect((sent.patch as { lines: Array<{ unit_price_minor: string }> }).lines[0]?.unit_price_minor).toBe("65000")
  })

  it("cancel restores the saved amounts", async () => {
    renderPanel()
    fireEvent.click(await screen.findByTestId("month-end-row-open-a"))
    const el = await editorReady()
    fireEvent.input(el, { target: { value: "650" } })

    await waitFor(() => expect(screen.getByTestId("month-end-row-total-a").textContent).toContain("780"))
    fireEvent.click(screen.getByTestId("month-end-row-cancel"))
    await waitFor(() => expect(screen.getByTestId("month-end-row-total-a").textContent).toContain("588"))
  })

  it("a changed run lists what changed, who changed it, the old and new totals, and offers approve on the new hash", async () => {
    const first = [item("a", "h-a", "58800"), item("b", "h-b", "58800")]
    const [items, setItems] = (await import("solid-js")).createSignal(first)
    render(() => (
      <MonthEndRunPanel approvalId="appr-1" status="pending" payload={{ run_id: "run-1", items: items() }} payloadHash="hash-2" canDecide viewerScopes={WRITE} />
    ))
    await screen.findByTestId("month-end-row-open-a")
    expect(screen.queryByTestId("month-end-changed")).toBeNull()
    rows = [
      row("a", "Hôtels Belcour", "78000", { latest_change: { actor_user_id: "u-sara", agent_id: "agent-1", fields: [] } }),
      row("b", "Le Comptoir Sud", "58800"),
    ]
    setItems([item("a", "h-a2", "78000"), item("b", "h-b", "58800")])
    const box = await screen.findByTestId("month-end-changed")
    await waitFor(() => expect(within(box).getByTestId("month-end-change-a").textContent).toContain("Hôtels Belcour changed"))
    expect(screen.getByTestId("month-end-changed-totals").textContent).toMatch(/1[,.  ]?176.*1[,.  ]?368/)
    fireEvent.click(screen.getByTestId("month-end-approve-new"))
    await waitFor(() => expect(decided).toEqual([["appr-1", "approve", "hash-2"]]))
  })

  it("each row shows its account manager or None, and Ask puts a mention in the box without sending", async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("month-end-row-manager-a").textContent).toContain("Élodie Renard"))
    expect(screen.getByTestId("month-end-row-manager-b").textContent).toContain("None")
    fireEvent.click(screen.getByTestId("month-end-row-open-a"))
    fireEvent.click(await screen.findByTestId("month-end-row-ask"))
    await waitFor(() => expect(mounted.at(-1)?.prefill).toBe("@Élodie Renard Hôtels Belcour: "))
    expect(calls.some((c) => c.tool.startsWith("threads") || c.tool.includes("reply"))).toBe(false)
  })

  it.each([
    { write: true, approve: true, edit: true, decider: false },
    { write: true, approve: false, edit: true, decider: true },
    { write: false, approve: true, edit: false, decider: false },
    { write: false, approve: false, edit: false, decider: true },
  ])("the four combinations of write and approve show the right controls (write $write, approve $approve)", async (c) => {
    renderPanel({ scopes: c.write ? WRITE : ["invoicing:documents:read"], canDecide: c.approve })
    fireEvent.click(await screen.findByTestId("month-end-row-open-a"))
    await screen.findByTestId("month-end-row-editor-a")
    expect(screen.queryByTestId("month-end-row-save-month") !== null).toBe(c.edit)
    expect(screen.queryByTestId("month-end-row-take-out") !== null).toBe(c.edit)
    expect(screen.queryByTestId("month-end-who-decides") !== null).toBe(c.decider)
    // Everyone may ask in the discussion.
    expect(screen.getByTestId("month-end-row-ask")).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("editor-field-customer-name")).toBeTruthy())
    expect((screen.getByTestId("editor-field-customer-name") as HTMLInputElement).disabled).toBe(!c.edit)
  })

  it("the first line and a waiting row's sentence show before any row", async () => {
    rows = [row("a", "Hôtels Belcour", "58800"), row("m", "Hôtel Mirabel", "58800", { state: "needs_fix", flags: ["Billing address missing"] })]
    renderPanel({ items: [item("a", "h-a", "58800")] })
    const first = await screen.findByTestId("month-end-first-line")
    expect(first.textContent).toContain("Drafts, no legal numbers yet. Everything here can still change: click a row to open it.")
    const waiting = await screen.findByTestId("month-end-waiting")
    expect(waiting.textContent).toContain("it stays a draft, uses no number and comes back to you once fixed")
    const list = screen.getByTestId("month-end-rows")
    // Both read before the rows, and the count leads the panel.
    expect(waiting.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId("month-end-approve-count").compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId("month-end-approve-count").textContent).toContain("1 invoices to approve")
    expect(screen.getByTestId("month-end-row-number-a").textContent).toContain("On 2026-11-30")
    expect(screen.getByTestId("month-end-row-number-m").textContent).toContain("None until fixed")
  })

  it("300 rows fold under same as October, counted in Approve N, with search by name", async () => {
    rows = Array.from({ length: 300 }, (_, i) => row(`r${i}`, `Client ${i}`, "12000"))
    rows[7] = row("r7", "Client 7", "12000", { flags: ["Changed since October"] })
    renderPanel()
    await screen.findByTestId("month-end-folded")
    expect(screen.getByTestId("month-end-folded").textContent).toBe("299 same as October")
    expect(screen.getByTestId("month-end-rows").children.length).toBe(1)
    expect(screen.getByTestId("month-end-approve-count").textContent).toContain("300 invoices to approve")
    fireEvent.input(screen.getByTestId("month-end-search"), { target: { value: "Client 42" } })
    await waitFor(() => expect(screen.getByTestId("month-end-row-r42")).toBeTruthy())
  })
})
