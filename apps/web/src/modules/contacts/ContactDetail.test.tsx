// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  // ContactDetail mounts SlotPanels, which calls `api.get('/v1/slots/:slot')`
  // on mount. Without a `get` stub the resource rejects outside any assertion
  // and surfaces as an unhandled rejection. No panels are registered in this
  // suite, so an empty list is the realistic payload.
  api: { get: vi.fn(async () => ({ panels: [] })) },
  loadContact: vi.fn(async () => undefined),
  loadBacklinks: vi.fn(async () => undefined),
  loadTicketBacklinks: vi.fn(),
  openContactDiscussion: vi.fn(async (..._args: unknown[]) => "t-c1"),
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
  openMerge: vi.fn(),
  mergeStore: { open: false, step: "search", targetCandidates: [], resolvedFields: {} },
  contactDetailStore: {
    contacts: {} as Record<string, any>,
    backlinks: {} as Record<string, any>,
    ticketBacklinks: {} as Record<string, any[]>,
    discussions: {} as Record<string, string>,
  },
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ userId: "u-me" }),
  hasScope: () => false,
}))
vi.mock("~/modules/shell/entity-preview/EntityPreview", () => ({
  default: (props: any) => (
    <span
      data-testid="entity-preview"
      data-app={props.app}
      data-entity-type={props.entityType}
      data-entity-id={props.entityId}
      data-trigger={props.trigger ?? "click-or-hover"}
    >
      {props.children}
    </span>
  ),
}))
vi.mock("~/modules/contacts/contact-detail-store", () => ({
  contactDetailStore: mocks.contactDetailStore,
  loadContact: mocks.loadContact,
  loadBacklinks: mocks.loadBacklinks,
  loadTicketBacklinks: mocks.loadTicketBacklinks,
  openContactDiscussion: mocks.openContactDiscussion,
  updateContact: mocks.updateContact,
  deleteContact: mocks.deleteContact,
}))
vi.mock("~/modules/threads/EntityDiscussion", () => ({
  default: (props: any) => (
    <div
      data-testid={props.testId}
      data-thread-id={props.threadId}
      data-placeholder={props.placeholder}
    />
  ),
}))
vi.mock("~/modules/contacts/contact-merge-store", () => ({
  mergeStore: mocks.mergeStore,
  openMerge: mocks.openMerge,
  closeMerge: vi.fn(),
  searchTargets: vi.fn(),
  selectTarget: vi.fn(),
  setFieldChoice: vi.fn(),
  confirmMerge: vi.fn(),
}))

describe("ContactDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.contactDetailStore.contacts = {
      c1: {
        id: "c1",
        name: "Alice",
        email: "a@x.com",
        phone: "+1",
        company: "Acme",
        externalIds: {},
        metadata: null,
      },
    }
    mocks.contactDetailStore.backlinks = {}
    mocks.contactDetailStore.discussions = {}
  })

  it("loads contact and first 20 backlinks on mount", async () => {
    const { ContactDetail } = await import("./ContactDetail")

    render(() => <ContactDetail entityId="c1" />)

    expect(mocks.loadContact).toHaveBeenCalledWith(mocks.api, "c1")
    expect(mocks.loadBacklinks).toHaveBeenCalledWith(mocks.api, "c1")
  })

  it("opens the contact's discussion and draws it in the side rail, named for the contact", async () => {
    mocks.contactDetailStore.discussions.c1 = "t-c1"
    const { ContactDetail } = await import("./ContactDetail")
    render(() => <ContactDetail entityId="c1" />)
    expect(mocks.openContactDiscussion).not.toHaveBeenCalled()
    const discussion = await screen.findByTestId("contact-discussion")
    expect(discussion).toHaveAttribute("data-thread-id", "t-c1")
    expect(discussion).toHaveAttribute("data-placeholder", "Write about Alice, or @ an agent")
    const pane = screen.getByTestId("contact-detail.discussion-pane")
    expect(pane.contains(discussion)).toBe(true)
    expect(pane).toHaveTextContent("Discussion")
    // Side by side where both fit, as on a task.
    expect(screen.getByTestId("contact-detail.layout").className).toContain(
      "@[860px]:grid-cols-[minmax(480px,1fr)_380px]",
    )
    // The Notes list and its box are gone.
    expect(screen.queryByTestId("contact-notes")).toBeNull()
  })

  it("asks for the discussion when the page has none yet, and says so when it cannot open", async () => {
    mocks.openContactDiscussion.mockRejectedValueOnce(new Error("nope"))
    const { ContactDetail } = await import("./ContactDetail")
    render(() => <ContactDetail entityId="c1" />)
    expect(mocks.openContactDiscussion).toHaveBeenCalledWith(mocks.api, "c1")
    expect(await screen.findByTestId("contact-discussion.unavailable")).toHaveTextContent(
      "The discussion could not be opened.",
    )
    expect(screen.queryByTestId("contact-discussion")).toBeNull()
  })

  it("says who can see the contact: the organisation, only me, or shared with me", async () => {
    const { ContactDetail } = await import("./ContactDetail")
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "organisation"],
      [{ orgAccess: "editor", ownerUserId: "u-me" }, "organisation"],
      [{ orgAccess: "none", ownerUserId: "u-me" }, "private"],
      [{ orgAccess: "none", ownerUserId: null }, "shared"],
    ]
    for (const [sharing, expected] of cases) {
      mocks.contactDetailStore.contacts.c1 = { ...mocks.contactDetailStore.contacts.c1, ...sharing }
      const { unmount } = render(() => <ContactDetail entityId="c1" />)
      expect(screen.getByTestId("contact-visibility")).toHaveAttribute("data-visibility", expected)
      expect(screen.getByTestId("contact-share-open")).toBeInTheDocument()
      unmount()
    }
  })

  it("renders contact fields and backlink load more", async () => {
    mocks.contactDetailStore.backlinks.c1 = {
      byId: { m1: { id: "m1", subject: "Hello", snippet: "Snippet" } },
      ids: ["m1"],
      cursor: "next",
      hasMore: true,
      loading: false,
    }
    const { ContactDetail } = await import("./ContactDetail")

    render(() => <ContactDetail entityId="c1" />)

    // Name appears twice: once in the hero h1, once in the inline-edit Name field.
    expect(screen.getAllByText("Alice").length).toBeGreaterThan(0)
    expect(screen.getAllByText("a@x.com")[0]).toBeInTheDocument()
    expect(screen.getByText("Hello")).toBeInTheDocument()
    const preview = screen.getByTestId("entity-preview")
    expect(preview).toHaveAttribute("data-app", "mail")
    expect(preview).toHaveAttribute("data-entity-type", "conversation")
    expect(preview).toHaveAttribute("data-entity-id", "m1")
    expect(preview).toHaveAttribute("data-trigger", "click-or-hover")
    fireEvent.click(screen.getByRole("button", { name: "Show all" }))
    expect(mocks.loadBacklinks).toHaveBeenLastCalledWith(mocks.api, "c1", {
      cursor: "next",
      append: true,
    })
  })

  it("a sealed related mail opened by this browser shows its decrypted subject, no locked text", async () => {
    mocks.contactDetailStore.backlinks.c1 = {
      byId: {
        m1: {
          id: "m1",
          subject: "Contract renewal",
          snippet: "Signed copy",
          sealed: true,
          encState: "opened",
        },
      },
      ids: ["m1"],
      cursor: null,
      hasMore: false,
      loading: false,
    }
    const { ContactDetail } = await import("./ContactDetail")
    render(() => <ContactDetail entityId="c1" />)

    expect(screen.getByText("Contract renewal")).toBeInTheDocument()
    expect(screen.getByText("Signed copy")).toBeInTheDocument()
    expect(screen.queryByText(/locked/i)).toBeNull()
    expect(screen.queryByTestId("contact-backlinks-locked")).toBeNull()
  })

  it("a sealed related mail on a locked mailbox says it is locked and how to unlock", async () => {
    mocks.contactDetailStore.backlinks.c1 = {
      byId: { m1: { id: "m1", subject: null, snippet: null, sealed: true, encState: "locked" } },
      ids: ["m1"],
      cursor: null,
      hasMore: false,
      loading: false,
    }
    const unlockRequests: unknown[] = []
    const listener = (event: Event) => unlockRequests.push((event as CustomEvent).detail)
    window.addEventListener("mailbox:unlock-requested", listener)
    try {
      const { ContactDetail } = await import("./ContactDetail")
      render(() => <ContactDetail entityId="c1" />)

      expect(screen.getByText("Locked conversation")).toBeInTheDocument()
      expect(screen.queryByText(/no subject/i)).toBeNull()
      const hint = screen.getByTestId("contact-backlinks-locked")
      expect(hint).toHaveTextContent("Unlock")
      fireEvent.click(screen.getByTestId("contact-backlinks-unlock"))
      expect(unlockRequests).toEqual([{ view: "unlock" }])
    } finally {
      window.removeEventListener("mailbox:unlock-requested", listener)
    }
  })

  it("opens merge flow from header button", async () => {
    const { ContactDetail } = await import("./ContactDetail")

    render(() => <ContactDetail entityId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "Merge with..." }))

    expect(mocks.openMerge).toHaveBeenCalledWith("c1")
  })

  it("Add to group: ticks the groups the contact is in, adds to another and removes from one (S15)", async () => {
    const { resetContactGroupsStore } = await import("./contact-groups-store")
    resetContactGroupsStore()
    const get = mocks.api.get
    get.mockImplementation((async (path: string) => {
      if (path === "/contacts/groups")
        return {
          data: [
            { id: "g1", name: "VIP", memberCount: 1 },
            { id: "g2", name: "Press", memberCount: 0 },
          ],
        }
      if (path === "/contacts/c1/groups") return { data: [{ id: "g1", name: "VIP" }] }
      return { panels: [] }
    }) as any)
    const post = vi.fn(async (path: string) => ({
      data: { groupId: path.split("/")[3], groupName: "x", changed: 1, unchanged: 0, notFound: [] },
    }))
    ;(mocks.api as any).post = post
    const { ContactDetail } = await import("./ContactDetail")

    render(() => <ContactDetail entityId="c1" />)
    fireEvent.click(screen.getByTestId("contact-add-to-group"))
    await vi.waitFor(() =>
      expect(screen.getByTestId("add-to-group-g1").getAttribute("aria-checked")).toBe("true"),
    )
    expect(screen.getByTestId("add-to-group-g2").getAttribute("aria-checked")).toBe("false")

    fireEvent.click(screen.getByTestId("add-to-group-g2"))
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/contacts/groups/g2/members", { contactIds: ["c1"] }),
    )
    await vi.waitFor(() =>
      expect(screen.getByTestId("add-to-group-g2").getAttribute("aria-checked")).toBe("true"),
    )

    fireEvent.click(screen.getByTestId("add-to-group-g1"))
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/contacts/groups/g1/members/remove", {
        contactIds: ["c1"],
      }),
    )
    get.mockImplementation((async () => ({ panels: [] })) as any)
    delete (mocks.api as any).post
  })
})
