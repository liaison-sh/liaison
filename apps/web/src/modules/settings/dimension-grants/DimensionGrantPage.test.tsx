// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  api: {},
  currentUserId: "admin-1",
  loadDimensions: vi.fn(),
  loadGrantsForUser: vi.fn(),
  loadUsers: vi.fn(),
  loadValues: vi.fn(),
  toggleGrant: vi.fn(),
  store: {
    dimensionDefs: [] as any[],
    error: null as string | null,
    grantsByUser: {} as Record<string, any>,
    selectedUserId: null as string | null,
    users: [] as any[],
    valuesByKey: {} as Record<string, any[]>,
  },
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ userId: mocks.currentUserId }),
}))
vi.mock("./dimension-grant-store", () => ({
  dimensionGrantStore: mocks.store,
  loadDimensions: mocks.loadDimensions,
  loadGrantsForUser: mocks.loadGrantsForUser,
  loadUsers: mocks.loadUsers,
  loadValues: mocks.loadValues,
  selectUser: (userId: string) => {
    mocks.store.selectedUserId = userId
  },
  toggleGrant: mocks.toggleGrant,
}))

describe("DimensionGrantPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, "", "/")
    mocks.currentUserId = "admin-1"
    mocks.store.dimensionDefs = [
      {
        app: "mail",
        key: "mail:inbox",
        label: "Inbox access",
        type: "membership",
        valueSource: { kind: "mail_accounts" },
      },
    ]
    mocks.store.error = null
    mocks.store.grantsByUser = {
      "admin-1": { "mail:inbox": { direct: ["acc-1"], derived: [], effective: ["acc-1"] } },
    }
    mocks.store.selectedUserId = "admin-1"
    mocks.store.users = [
      { id: "admin-1", name: "Admin One", email: "admin@example.com", isActive: true },
    ]
    mocks.store.valuesByKey = {
      "mail:inbox": [
        { value: "acc-1", label: "Support" },
        { value: "acc-2", label: "Sales" },
      ],
    }
  })

  it("renders membership dimensions as checkboxes", async () => {
    const { default: DimensionGrantPage } = await import("./DimensionGrantPage")

    render(() => <DimensionGrantPage />)

    expect(screen.getByTestId("dimension-grant-page")).toBeInTheDocument()
    expect(screen.getByText("Inbox access")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Support" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Sales" })).not.toBeChecked()
  })

  it("asks for values only where the server names a value source", async () => {
    // A gestalt walk: every visit threw "Unknown dimension or no value source"
    // (404 on tickets:team and calendar:calaccess values), which have none.
    mocks.store.dimensionDefs = [
      ...mocks.store.dimensionDefs,
      { app: "tickets", key: "tickets:team", label: "team", type: "membership" },
      {
        app: "crm",
        key: "crm:region",
        label: "region",
        type: "membership",
        values: ["emea", "apac"],
      },
    ]
    mocks.store.valuesByKey = {}
    const { default: DimensionGrantPage } = await import("./DimensionGrantPage")
    render(() => <DimensionGrantPage />)
    await vi.waitFor(() => expect(mocks.loadValues).toHaveBeenCalledTimes(1))
    expect(mocks.loadValues).toHaveBeenCalledWith(mocks.api, "mail:inbox")
    // A dimension that declares its values lists them without asking.
    expect(screen.getByRole("checkbox", { name: "emea" })).toBeInTheDocument()
  })

  it("highlights the grant value from dimension and value URL params", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings/admin/dimension-grants?dimension=mail%3Ainbox&value=acc-2",
    )
    const { default: DimensionGrantPage } = await import("./DimensionGrantPage")

    render(() => <DimensionGrantPage />)

    expect(screen.getByTestId("dimension-grant-target-value")).toHaveTextContent("Sales")
    expect(screen.getByTestId("dimension-grant-target-value")).toHaveAttribute(
      "aria-current",
      "true",
    )
  })

  it("requires confirmation before current admin revokes their own mail inbox grant", async () => {
    const { default: DimensionGrantPage } = await import("./DimensionGrantPage")
    render(() => <DimensionGrantPage />)

    await fireEvent.click(screen.getByRole("checkbox", { name: "Support" }))

    expect(screen.getByText(/You will lose access to this inbox/)).toBeInTheDocument()
    expect(mocks.toggleGrant).not.toHaveBeenCalled()
  })

  it("renders role-derived grants as read-only", async () => {
    mocks.store.grantsByUser = {
      "admin-1": {
        "mail:inbox": {
          direct: ["acc-1"],
          derived: [{ roleId: "role-1", values: ["acc-2"] }],
          effective: ["acc-1", "acc-2"],
        },
      },
    }
    const { default: DimensionGrantPage } = await import("./DimensionGrantPage")

    render(() => <DimensionGrantPage />)

    expect(screen.getByRole("checkbox", { name: /Sales/ })).toBeDisabled()
    expect(screen.getByText("from role")).toBeInTheDocument()
  })

  it("renders deactivated teammate banner and unknown type placeholder", async () => {
    mocks.store.dimensionDefs = [
      { app: "mail", key: "mail:unknown", label: "Unknown", type: "custom" },
    ]
    mocks.store.selectedUserId = "user-2"
    mocks.store.users = [{ id: "user-2", name: "Dormant User", isActive: false }]
    const { default: DimensionGrantPage } = await import("./DimensionGrantPage")

    render(() => <DimensionGrantPage />)

    expect(screen.getByText(/deactivated/)).toBeInTheDocument()
    expect(screen.getByText("Not yet supported")).toBeInTheDocument()
  })

  it("renders no-team empty state with invite link", async () => {
    mocks.store.users = []
    mocks.store.selectedUserId = null
    const { default: DimensionGrantPage } = await import("./DimensionGrantPage")

    render(() => <DimensionGrantPage />)

    expect(screen.getByText("No teammates yet")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Invite teammates" })).toHaveAttribute(
      "href",
      "/settings/admin/users",
    )
  })
})
