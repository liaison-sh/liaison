// SPDX-License-Identifier: FSL-1.1-ALv2

import type { CustomerResolution } from "@liaison/api-connector-core/contract"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { notifyEntityChange } from "~/framework/entity-changes"
import { ApiError } from "~/lib/api-error"

const state = vi.hoisted(() => ({
  api: { get: vi.fn() } as { get: ReturnType<typeof vi.fn> },
  tier: "desktop" as "desktop" | "tablet" | "phone",
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/shell/shell-tier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/shell-tier")>()),
  shellTier: () => state.tier,
}))

import { CustomerCard } from "./CustomerCard"

const acme: CustomerResolution = {
  configured: true,
  matches: [
    {
      connection: "crm",
      connectionName: "Fixture CRM",
      matchedBy: "email",
      summary: {
        id: "c-1",
        name: "Acme Instruments",
        segment: "Enterprise",
        url: "https://crm.example.com/companies/c-1",
      },
      orders: [
        { number: "SO-1001", date: "2026-09-14T10:00:00Z", total: 1250.5, currency: "EUR" },
        { number: "SO-1002", date: "2026-10-01", total: 80, currency: "EUR" },
      ],
      invoices: [{ number: "INV-77", dueDate: "2026-11-01", amount: 300, currency: "USD" }],
    },
  ],
  connections: [{ identifier: "crm", name: "Fixture CRM" }],
  errors: [],
}

function lookupPath(): string {
  return String(state.api.get.mock.calls[0]?.[0] ?? "")
}

describe("CustomerCard", () => {
  beforeEach(() => {
    state.api.get = vi.fn()
    state.tier = "desktop"
  })

  it("reads the customer again once an approved connector write lands, without blanking", async () => {
    const noMatch: CustomerResolution = { ...acme, matches: [] }
    state.api.get.mockResolvedValueOnce(noMatch).mockResolvedValueOnce(acme)
    render(() => <CustomerCard email="Ines@new-customer.example" variant="panel" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-no-match")).toBeTruthy())

    const approvalUpdate = (status: string, params: Record<string, unknown>) =>
      notifyEntityChange({
        key: "kernel:approval_request",
        app: "kernel",
        entity: "approval_request",
        action: "update",
        data: {
          status,
          toolName: "api-connector:connector_write",
          currentPayload: { connection: "crm", operation: "create_contact", params },
        },
      })
    // Not yet executed, another tool, or another person: no new lookup.
    approvalUpdate("approving", { email: "ines@new-customer.example" })
    approvalUpdate("approved", { email: "someone.else@example.com" })
    notifyEntityChange({
      key: "kernel:approval_request",
      app: "kernel",
      entity: "approval_request",
      action: "update",
      data: { status: "approved", toolName: "tickets:addNote", currentPayload: {} },
    })
    await new Promise((r) => setTimeout(r, 400))
    expect(state.api.get).toHaveBeenCalledTimes(1)

    approvalUpdate("approved", { email: "ines@new-customer.example" })
    await waitFor(() => expect(screen.getByTestId("customer-card-state-match")).toBeTruthy())
    expect(state.api.get).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId("customer-card-state-loading")).toBeNull()
  })

  it("shows a skeleton while the lookup runs", async () => {
    state.api.get.mockReturnValue(new Promise(() => {}))
    render(() => <CustomerCard email="buyer@acme.example" variant="panel" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-loading")).toBeTruthy())
    expect(lookupPath()).toBe("/api-connector/customer?email=buyer%40acme.example")
  })

  it("renders the matched customer with summary fields, locale-formatted lists and a link out", async () => {
    state.api.get.mockResolvedValue(acme)
    render(() => <CustomerCard email="buyer@acme.example" variant="panel" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-match")).toBeTruthy())
    expect(screen.getByTestId("customer-card-name").textContent).toBe("Acme Instruments")
    expect(screen.getByTestId("customer-card-system").textContent).toContain("Fixture CRM")
    expect(screen.getByTestId("customer-card-field-segment").textContent).toContain("Enterprise")
    // The record id and the url are not shown as fields: the url is the link out.
    expect(screen.queryByTestId("customer-card-field-id")).toBeNull()
    expect(screen.queryByTestId("customer-card-field-url")).toBeNull()
    const link = screen.getByTestId("customer-card-link") as HTMLAnchorElement
    expect(link.href).toBe("https://crm.example.com/companies/c-1")
    expect(link.rel).toContain("noopener")

    const orders = screen.getByTestId("customer-card-list-orders")
    const rows = orders.querySelectorAll('[data-testid="customer-card-row"]')
    expect(rows.length).toBe(2)
    // The count printed equals the rows listed.
    expect(screen.getByTestId("customer-card-count-orders").textContent).toBe("2")
    expect(rows[0]?.textContent).toContain("SO-1001")
    expect(rows[0]?.textContent).toContain("€1,250.50")
    expect(rows[0]?.textContent).toContain("9/14/26")
    expect(orders.textContent).not.toContain("NaN")
    expect(orders.textContent).not.toContain("1970")
    const invoices = screen.getByTestId("customer-card-list-invoices")
    expect(invoices.textContent).toContain("$300.00")
    expect(screen.queryByTestId("customer-card-list-deals")).toBeNull()
  })

  it("offers a compact picker when several records match, and switches on pick", async () => {
    state.api.get.mockResolvedValue({
      configured: true,
      matches: [
        {
          connection: "crm",
          connectionName: "CRM",
          matchedBy: "email",
          summary: { id: "1", name: "Acme Instruments" },
        },
        {
          connection: "erp",
          connectionName: "ERP",
          matchedBy: "email",
          summary: { id: "9", name: "Acme GmbH" },
        },
      ],
      connections: [
        { identifier: "crm", name: "CRM" },
        { identifier: "erp", name: "ERP" },
      ],
      errors: [],
    } satisfies CustomerResolution)
    render(() => <CustomerCard email="buyer@acme.example" variant="panel" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-several")).toBeTruthy())
    const picker = screen.getByTestId("customer-card-picker") as HTMLSelectElement
    expect(picker.options.length).toBe(2)
    expect(screen.getByTestId("customer-card-name").textContent).toBe("Acme Instruments")
    fireEvent.change(picker, { target: { value: "1" } })
    await waitFor(() =>
      expect(screen.getByTestId("customer-card-name").textContent).toBe("Acme GmbH"),
    )
  })

  it("says plainly when no customer matches, naming the system and the email", async () => {
    state.api.get.mockResolvedValue({
      configured: true,
      matches: [],
      connections: [{ identifier: "crm", name: "Fixture CRM" }],
      errors: [],
    } satisfies CustomerResolution)
    render(() => <CustomerCard email="stranger@nowhere.example" variant="panel" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-no-match")).toBeTruthy())
    const text = screen.getByTestId("customer-card-state-no-match").textContent ?? ""
    expect(text).toContain("Fixture CRM")
    expect(text).toContain("stranger@nowhere.example")
  })

  it("shows a short error with a retry that looks the customer up again", async () => {
    state.api.get
      .mockRejectedValueOnce(
        new ApiError("upstream said: secret-token-123 invalid", 502, "upstream_status"),
      )
      .mockResolvedValueOnce(acme)
    render(() => <CustomerCard email="buyer@acme.example" variant="panel" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-error")).toBeTruthy())
    // The upstream message never reaches the card.
    expect(screen.getByTestId("customer-card").textContent).not.toContain("secret-token-123")
    fireEvent.click(screen.getByTestId("customer-card-retry"))
    await waitFor(() => expect(screen.getByTestId("customer-card-state-match")).toBeTruthy())
    expect(state.api.get).toHaveBeenCalledTimes(2)
  })

  it("is absent when no connection is configured", async () => {
    state.api.get.mockResolvedValue({ configured: false, matches: [] })
    render(() => <CustomerCard email="buyer@acme.example" variant="panel" />)
    await waitFor(() => expect(state.api.get).toHaveBeenCalled())
    await Promise.resolve()
    expect(screen.queryByTestId("customer-card")).toBeNull()
  })

  it("is absent for a viewer without the read scope (403), never an error card", async () => {
    state.api.get.mockRejectedValue(new ApiError("Forbidden", 403, "forbidden"))
    render(() => <CustomerCard email="buyer@acme.example" variant="panel" />)
    await waitFor(() => expect(state.api.get).toHaveBeenCalled())
    await Promise.resolve()
    expect(screen.queryByTestId("customer-card")).toBeNull()
  })

  it("does not look anything up without an email", () => {
    render(() => <CustomerCard email={null} variant="panel" />)
    expect(state.api.get).not.toHaveBeenCalled()
    expect(screen.queryByTestId("customer-card")).toBeNull()
  })

  it("as a header card starts collapsed on narrow widths and expands on toggle", async () => {
    state.tier = "phone"
    state.api.get.mockResolvedValue(acme)
    render(() => <CustomerCard email="buyer@acme.example" variant="header" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-match")).toBeTruthy())
    expect(screen.getByTestId("customer-card").dataset.collapsed).toBe("true")
    expect(screen.queryByTestId("customer-card-body")).toBeNull()
    // The name stays readable while collapsed.
    expect(screen.getByTestId("customer-card-name").textContent).toBe("Acme Instruments")
    fireEvent.click(screen.getByTestId("customer-card-toggle"))
    expect(screen.getByTestId("customer-card").dataset.collapsed).toBe("false")
    expect(screen.getByTestId("customer-card-body")).toBeTruthy()
  })

  it("as a header card starts expanded on desktop", async () => {
    state.api.get.mockResolvedValue(acme)
    render(() => <CustomerCard email="buyer@acme.example" variant="header" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-match")).toBeTruthy())
    expect(screen.getByTestId("customer-card").dataset.collapsed).toBe("false")
  })

  it("never renders a link out that is not http(s)", async () => {
    state.api.get.mockResolvedValue({
      configured: true,
      matches: [
        {
          connection: "crm",
          connectionName: "CRM",
          matchedBy: "email",
          summary: { id: "1", name: "Acme", url: "javascript:alert(1)" },
        },
      ],
      connections: [{ identifier: "crm", name: "CRM" }],
      errors: [],
    } satisfies CustomerResolution)
    render(() => <CustomerCard email="buyer@acme.example" variant="panel" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-match")).toBeTruthy())
    expect(screen.queryByTestId("customer-card-link")).toBeNull()
  })

  it("labels a company-domain match and never presents it as the sender (P2-SK2)", async () => {
    state.api.get.mockResolvedValue({
      configured: true,
      matches: [
        {
          connection: "erp",
          connectionName: "Fixture ERP",
          matchedBy: "domain",
          summary: { id: "a9", name: "ACME SAS" },
        },
      ],
      connections: [{ identifier: "erp", name: "Fixture ERP" }],
      errors: [],
    } satisfies CustomerResolution)
    render(() => <CustomerCard email="new.person@acme.example" variant="panel" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-match")).toBeTruthy())
    expect(screen.getByTestId("customer-card-matched-by-domain").textContent).toBe(
      "Matched by company domain",
    )
  })

  it("shows no domain label on an email match", async () => {
    state.api.get.mockResolvedValue(acme)
    render(() => <CustomerCard email="buyer@acme.example" variant="panel" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-match")).toBeTruthy())
    expect(screen.queryByTestId("customer-card-matched-by-domain")).toBeNull()
  })

  // The fixture CRM's shapes, as the demo serves them (P2-V2..V5).
  const fixture: CustomerResolution = {
    configured: true,
    matches: [
      {
        connection: "crm",
        connectionName: "Fixture CRM",
        matchedBy: "email",
        currency: "EUR",
        summary: {
          id: "cmp_001",
          name: "Acme Instruments",
          currency: "EUR",
          "account_manager.name": "Celine Durand",
          "account_manager.email": "celine.durand@fixture-crm.example",
          contacts_count: 3,
          lifetime_value: 14526,
          open_balance: 8726.5,
        },
        deals: [
          {
            id: "dl_001",
            title: "Lab bench refresh",
            stage: "proposal",
            amount: 29400,
            currency: "EUR",
            expected_close: "2026-11-30",
            owner: { name: "Celine Durand" },
          },
          {
            id: "dl_002",
            title: "Probe kits",
            stage: "won",
            amount: 4560,
            currency: "EUR",
            expected_close: "2026-10-01",
            owner: { name: "Sam Okafor" },
          },
        ],
        orders: [
          { id: "ord_1", number: "SO-1001", date: "2026-10-20", total: 5256, currency: "EUR" },
        ],
        invoices: [{ id: "inv_1", number: "INV-2001", total: 5256, currency: "EUR" }],
      },
    ],
    connections: [{ identifier: "crm", name: "Fixture CRM" }],
    errors: [],
  }

  async function renderFixture(resolution: CustomerResolution = fixture) {
    state.api.get.mockResolvedValue(resolution)
    render(() => <CustomerCard email="jane.doe@acme-instruments.example" variant="panel" />)
    await waitFor(() => expect(screen.getByTestId("customer-card-state-match")).toBeTruthy())
  }

  it("formats summary money in the record's currency and counts as numbers (P2-V2)", async () => {
    await renderFixture()
    expect(screen.getByTestId("customer-card-field-lifetime_value").textContent).toContain(
      "€14,526.00",
    )
    expect(screen.getByTestId("customer-card-field-open_balance").textContent).toContain(
      "€8,726.50",
    )
    expect(screen.getByTestId("customer-card-field-contacts_count").textContent).toContain("3")
    expect(screen.getByTestId("customer-card-field-contacts_count").textContent).not.toContain("€")
  })

  it("takes the summary's currency from the match, not from a field it happens to show", async () => {
    const [m] = fixture.matches
    if (!m) throw new Error("fixture")
    const { currency: _c, ...summary } = m.summary
    await renderFixture({ ...fixture, matches: [{ ...m, summary, currency: "EUR" }] })
    expect(screen.getByTestId("customer-card-field-lifetime_value").textContent).toContain(
      "€14,526.00",
    )
  })

  it("prints a summary amount as a plain locale number when the record names no currency", async () => {
    const [m] = fixture.matches
    if (!m) throw new Error("fixture")
    const { currency: _c, ...summary } = m.summary
    await renderFixture({
      ...fixture,
      matches: [{ ...m, currency: undefined, summary }],
    })
    const field = screen.getByTestId("customer-card-field-lifetime_value").textContent ?? ""
    expect(field).toContain("14,526")
    expect(field).not.toContain("€")
  })

  it("titles a deal row by its own title, never its owner's name (P2-V3)", async () => {
    await renderFixture()
    const titles = Array.from(
      screen
        .getByTestId("customer-card-list-deals")
        .querySelectorAll('[data-testid="customer-card-row-title"]'),
    ).map((el) => el.textContent)
    expect(titles).toEqual(["Lab bench refresh", "Probe kits"])
    const orderTitle = screen
      .getByTestId("customer-card-list-orders")
      .querySelector('[data-testid="customer-card-row-title"]')
    expect(orderTitle?.textContent).toBe("SO-1001")
    const invoiceTitle = screen
      .getByTestId("customer-card-list-invoices")
      .querySelector('[data-testid="customer-card-row-title"]')
    expect(invoiceTitle?.textContent).toBe("INV-2001")
  })

  it("a list row's full title is its tooltip, and its date is short and never wraps", async () => {
    await renderFixture()
    const deals = screen.getByTestId("customer-card-list-deals")
    const title = deals.querySelector('[data-testid="customer-card-row-title"]')
    // The title truncates in a narrow panel: the whole name stays one hover away.
    expect(title?.getAttribute("title")).toBe("Lab bench refresh")
    const date = screen
      .getByTestId("customer-card-list-orders")
      .querySelector('[data-testid="customer-card-row-date"]')
    expect(date?.classList.contains("whitespace-nowrap")).toBe(true)
    expect(date?.classList.contains("shrink-0")).toBe(true)
    // The short numeric style (10/20/26), not "Oct 20, 2026" wrapped over three lines.
    expect(date?.textContent).toMatch(/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/)
  })

  it("labels the deals list 'Deals' and shows each deal's status (P2-V4)", async () => {
    await renderFixture()
    const deals = screen.getByTestId("customer-card-list-deals")
    expect(deals.textContent).toContain("Deals")
    expect(deals.textContent).not.toContain("Open deals")
    const statuses = Array.from(
      deals.querySelectorAll('[data-testid="customer-card-row-status"]'),
    ).map((el) => el.textContent)
    expect(statuses).toEqual(["proposal", "won"])
  })

  it("labels a nested field by its whole path (P2-V5)", async () => {
    await renderFixture()
    expect(
      screen.getByTestId("customer-card-field-account_manager.name").querySelector("dt")
        ?.textContent,
    ).toBe("Account manager name")
    expect(
      screen.getByTestId("customer-card-field-account_manager.email").querySelector("dt")
        ?.textContent,
    ).toBe("Account manager email")
  })
})
