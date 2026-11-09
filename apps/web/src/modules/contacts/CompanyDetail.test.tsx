// SPDX-License-Identifier: FSL-1.1-ALv2
// The company page: its sections in their set order, Waiting only when the
// reader has approvals linked to the company, no access for a company not
// shared with them, no actions for a reader who cannot write, Add person
// linking through the company route, and the tab labelled by the company.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { CompanyDetail } from "./CompanyDetail"
import { loadCompany, resetCompanyStores } from "./company-store"
import { resolveCompanyTabLabel } from "./exports"

const mocks = vi.hoisted(() => ({
  routes: {} as Record<string, unknown>,
  posts: [] as Array<{ path: string; body: unknown }>,
  postResult: {} as Record<string, unknown>,
  scopes: ["*"] as string[],
  items: [] as Array<Record<string, unknown>>,
  slots: [] as Array<{ panel: Record<string, unknown>; component: unknown }>,
  openTab: vi.fn(),
}))

function respond(path: string): unknown {
  const key = Object.keys(mocks.routes).find((k) => path === k || path.startsWith(`${k}?`))
  if (!key) throw new ApiError("Not found", 404)
  const value = mocks.routes[key]
  if (value instanceof Error) throw value
  return value
}

const api = {
  get: vi.fn(async (path: string) => respond(path)),
  getEnvelope: vi.fn(async (path: string) => respond(path)),
  post: vi.fn(async (path: string, body?: unknown) => {
    mocks.posts.push({ path, body })
    if (path === "/apps/run-tool") {
      const tool = (body as { toolName: string }).toolName
      return mocks.postResult[tool] ?? {}
    }
    return mocks.postResult[path] ?? {}
  }),
  patch: vi.fn(),
  delete: vi.fn(),
}

vi.mock("~/modules/shell/ApiContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/ApiContext")>()),
  useApi: () => api,
  useOptionalApi: () => api,
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "u-me", name: "Me", scopes: mocks.scopes }),
  hasScope: (scope: string) =>
    mocks.scopes.includes("*") || mocks.scopes.some((s) => scope.startsWith(s)),
}))
vi.mock("~/modules/shell/tab-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/tab-store")>()),
  openTab: mocks.openTab,
}))
vi.mock("~/modules/shell/attention-store", () => ({
  attentionStore: {
    get items() {
      return mocks.items
    },
  },
}))
vi.mock("~/modules/shell/AttentionRow", () => ({
  default: (props: { item: { action: { approvalId: string } } }) => (
    <div data-testid={`waiting-row-${props.item.action.approvalId}`} />
  ),
}))
vi.mock("~/modules/shell/SlotPanels", () => ({
  createSlotPanels: () => () => mocks.slots,
  SlotEntryView: (props: { entry: { panel: { id: string } } }) => (
    <div data-testid={`slot-entry-${props.entry.panel.id}`} />
  ),
}))
vi.mock("~/modules/threads/EntityDiscussion", () => ({
  default: () => <div data-testid="company-discussion-thread" />,
}))

const CO = "co-1"
const company = (extra: Record<string, unknown> = {}) => ({
  id: CO,
  name: "Maison Arlon",
  domain: "maison-arlon.example",
  description: "Hotel group, 6 hotels",
  orgAccess: "editor",
  createdBy: "u-other",
  peopleCount: 2,
  openDeal: { taskId: "deal-1", stage: "Proposal", amountMinor: 1740000, currency: "EUR" },
  ...extra,
})

const approvalItem = (approvalId: string) => ({
  id: `kernel:approval_pending:${approvalId}`,
  action: { type: "decide_approval", approvalId },
})

function seedWorld(): void {
  mocks.routes = {
    [`/contacts/companies/${CO}`]: company(),
    [`/contacts/companies/${CO}/waiting`]: { approvalIds: ["a-company", "a-person", "a-deal"] },
    [`/contacts/companies/${CO}/sharing`]: { users: [], roles: [] },
    "/contacts": {
      data: [
        { id: "p-new", name: "Julien Ferrand", email: "julien@maison-arlon.example" },
        { id: "p-in", name: "Claire Vidal", email: "claire@maison-arlon.example", companyId: CO },
      ],
    },
  }
  mocks.postResult = {
    "kernel:companies_read": {
      people: [
        {
          id: "p-1",
          name: "Claire Vidal",
          email: "c@x.example",
          role: null,
          isMain: true,
          lastInboundAt: "2026-11-01",
        },
        {
          id: "p-2",
          name: "Amandine Roux",
          email: "a@x.example",
          role: null,
          isMain: false,
          lastInboundAt: "2026-11-05",
        },
      ],
      accountManager: { id: "u-elodie", name: "Elodie Renard", away: null },
    },
    [`/contacts/companies/${CO}/discussion`]: { threadId: "t-co" },
  }
  mocks.items = [
    approvalItem("a-company"),
    approvalItem("a-person"),
    approvalItem("a-deal"),
    approvalItem("a-other-company"),
    { id: "kernel:alert:x", action: { type: "open_entity" } },
  ]
  mocks.slots = [
    {
      panel: { id: "work-projects", app: "projects", group: "work", label: "Work" },
      component: null,
    },
    {
      panel: { id: "money-invoices", app: "invoicing", group: "money", label: "Money" },
      component: null,
    },
    {
      panel: { id: "support-tickets", app: "tickets", group: "support", label: "Support" },
      component: null,
    },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  resetCompanyStores()
  mocks.posts = []
  mocks.scopes = ["*"]
  seedWorld()
})
afterEach(() => cleanup())

/** The page's sections, by test id, in document order. */
function sectionOrder(): string[] {
  const all = Array.from(document.querySelectorAll("[data-testid]")).map(
    (el) => el.getAttribute("data-testid") ?? "",
  )
  const wanted = [
    "company-detail.actions",
    "company-detail.waiting",
    "company-detail.people",
    "company-detail.deals",
    "company-detail.section-money",
    "company-detail.section-support",
    "company-detail.section-work",
    "company-detail.timeline",
    "company-detail.discussion",
  ]
  return all.filter((id) => wanted.includes(id))
}

describe("CompanyDetail", () => {
  it("sections render in their set order and Waiting only when it has rows", async () => {
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.waiting")
    await screen.findByTestId("company-person-p-1")
    expect(sectionOrder()).toEqual([
      "company-detail.actions",
      "company-detail.waiting",
      "company-detail.people",
      "company-detail.deals",
      "company-detail.section-money",
      "company-detail.section-support",
      "company-detail.section-work",
      "company-detail.timeline",
      "company-detail.discussion",
    ])
    // People: the most recent mail first.
    const people = screen.getAllByTestId(/^company-person-/).map((el) => el.dataset.testid)
    expect(people).toEqual(["company-person-p-2", "company-person-p-1"])
    expect(screen.getByTestId("company-detail.manager").textContent).toContain("Elodie Renard")
    expect(screen.getByTestId(`company-deal-deal-1`).textContent).toContain("Proposal")

    cleanup()
    resetCompanyStores()
    mocks.routes[`/contacts/companies/${CO}/waiting`] = { approvalIds: [] }
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-person-p-1")
    expect(screen.queryByTestId("company-detail.waiting")).toBeNull()
  })

  it("Waiting lists the viewer's pending approvals linked to this company, its people or its deals, and not another company's", async () => {
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.waiting")
    const rows = screen.getAllByTestId(/^waiting-row-/).map((el) => el.dataset.testid)
    expect(rows).toEqual(["waiting-row-a-company", "waiting-row-a-person", "waiting-row-a-deal"])
    expect(screen.queryByTestId("waiting-row-a-other-company")).toBeNull()
  })

  it("a company not shared with me shows no access", async () => {
    mocks.routes[`/contacts/companies/${CO}`] = new ApiError("Company not found", 404)
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.no-access")
    expect(screen.queryByTestId("company-detail.title")).toBeNull()
    expect(mocks.posts.find((p) => p.path === "/apps/run-tool")).toBeUndefined()
  })

  it("a reader without write sees no action buttons", async () => {
    mocks.scopes = ["kernel:contacts:read", "kernel:companies:read"]
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.title")
    expect(screen.queryByTestId("company-detail.actions")).toBeNull()
    expect(screen.queryByTestId("company-detail.add-person")).toBeNull()
    expect(screen.queryByTestId("company-detail.merge")).toBeNull()
  })

  it("a private company of mine with nobody else says only I see it", async () => {
    mocks.routes[`/contacts/companies/${CO}`] = company({ orgAccess: "none", createdBy: "u-me" })
    render(() => <CompanyDetail entityId={CO} />)
    await waitFor(() =>
      expect(screen.getByTestId("company-detail.visibility").dataset.visibility).toBe("only-you"),
    )
    expect(screen.getByTestId("company-detail.visibility").textContent).toContain(
      "Only you see this company",
    )
  })

  it("adding a person links them and writes the company name", async () => {
    render(() => <CompanyDetail entityId={CO} />)
    fireEvent.click(await screen.findByTestId("company-detail.add-person"))
    fireEvent.input(screen.getByTestId("company-detail.add-search"), {
      target: { value: "Julien" },
    })
    // Someone already at the company is not offered again.
    fireEvent.click(await screen.findByTestId("company-detail.add-hit-p-new"))
    expect(screen.queryByTestId("company-detail.add-hit-p-in")).toBeNull()
    await waitFor(() =>
      expect(mocks.posts).toContainEqual({
        path: `/contacts/companies/${CO}/contacts`,
        body: { contactIds: ["p-new"] },
      }),
    )
    expect((await screen.findByTestId("company-detail.add-message")).textContent).toBe(
      "Julien Ferrand now works at Maison Arlon.",
    )
  })
})

describe("company tab label", () => {
  it("a company tab is labelled with the company's name and an unshared one opens as no access", async () => {
    expect(resolveCompanyTabLabel(CO)).toBeUndefined()
    await loadCompany(api as never, CO)
    expect(resolveCompanyTabLabel(CO)).toBe("Maison Arlon")
    mocks.routes["/contacts/companies/co-hidden"] = new ApiError("Company not found", 404)
    await loadCompany(api as never, "co-hidden")
    expect(resolveCompanyTabLabel("co-hidden")).toBe("No access")
  })
})
