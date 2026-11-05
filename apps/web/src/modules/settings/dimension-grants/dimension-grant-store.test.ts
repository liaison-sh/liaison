// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("dimension-grant-store", () => {
  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("./dimension-grant-store")
    mod.resetDimensionGrantStore()
  })

  it("loadDimensions populates dimensionDefs", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        data: [{ key: "mail:inbox", app: "mail", label: "Inbox access", type: "membership" }],
      }),
    }
    const { dimensionGrantStore, loadDimensions } = await import("./dimension-grant-store")

    await loadDimensions(api)

    expect(api.get).toHaveBeenCalledWith("/apps/dimensions")
    expect(dimensionGrantStore.dimensionDefs[0]?.key).toBe("mail:inbox")
  })

  it("loadValues populates valuesByKey", async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: [{ value: "acc-1", label: "Support" }] }) }
    const { dimensionGrantStore, loadValues } = await import("./dimension-grant-store")

    await loadValues(api, "mail:inbox")

    expect(api.get).toHaveBeenCalledWith("/apps/dimensions/mail%3Ainbox/values")
    expect(dimensionGrantStore.valuesByKey["mail:inbox"]?.[0]?.value).toBe("acc-1")
  })

  it("loadGrantsForUser merges direct and derived grants", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        data: {
          direct: { "mail:inbox": ["acc-1"] },
          derived: { "mail:inbox": [{ roleId: "role-1", values: ["acc-2"] }] },
        },
      }),
    }
    const { dimensionGrantStore, loadGrantsForUser } = await import("./dimension-grant-store")

    await loadGrantsForUser(api, "user-1")

    expect(dimensionGrantStore.grantsByUser["user-1"]?.["mail:inbox"]?.direct).toEqual(["acc-1"])
    expect(dimensionGrantStore.grantsByUser["user-1"]?.["mail:inbox"]?.effective).toEqual([
      "acc-1",
      "acc-2",
    ])
  })

  it("toggleGrant on appends and posts values", async () => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValue({ data: { direct: { "mail:inbox": ["acc-1", "acc-2"] }, derived: {} } }),
      post: vi.fn().mockResolvedValue({}),
      delete: vi.fn(),
    }
    const { loadGrantsForUser, toggleGrant } = await import("./dimension-grant-store")
    await loadGrantsForUser(api, "user-1")

    await toggleGrant(api, "user-1", "mail:inbox", "acc-2", true)

    expect(api.post).toHaveBeenCalledWith("/admin/roles/users/user-1/dimensions", {
      dimension: "mail:inbox",
      values: ["acc-1", "acc-2"],
    })
  })

  it("toggleGrant applies optimistic state before the request resolves", async () => {
    let resolvePost!: () => void
    const api = {
      get: vi
        .fn()
        .mockResolvedValue({ data: { direct: { "mail:inbox": ["acc-1"] }, derived: {} } }),
      post: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePost = resolve
          }),
      ),
      delete: vi.fn(),
    }
    const { dimensionGrantStore, loadGrantsForUser, toggleGrant } = await import(
      "./dimension-grant-store"
    )
    await loadGrantsForUser(api, "user-1")

    const pending = toggleGrant(api, "user-1", "mail:inbox", "acc-2", true)
    expect(dimensionGrantStore.grantsByUser["user-1"]?.["mail:inbox"]?.direct).toEqual([
      "acc-1",
      "acc-2",
    ])
    resolvePost()
    await pending
  })

  it("toggleGrant off deletes the dimension when no values remain", async () => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValue({ data: { direct: { "mail:inbox": ["acc-1"] }, derived: {} } }),
      post: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    }
    const { loadGrantsForUser, toggleGrant } = await import("./dimension-grant-store")
    await loadGrantsForUser(api, "user-1")

    await toggleGrant(api, "user-1", "mail:inbox", "acc-1", false)

    expect(api.delete).toHaveBeenCalledWith("/admin/roles/users/user-1/dimensions/mail%3Ainbox")
  })

  it("rolls back optimistic state and exposes an error when mutation fails", async () => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValue({ data: { direct: { "mail:inbox": ["acc-1"] }, derived: {} } }),
      post: vi.fn().mockRejectedValue(new Error("Forbidden")),
      delete: vi.fn(),
    }
    const { dimensionGrantStore, loadGrantsForUser, toggleGrant } = await import(
      "./dimension-grant-store"
    )
    await loadGrantsForUser(api, "user-1")

    await expect(toggleGrant(api, "user-1", "mail:inbox", "acc-2", true)).rejects.toThrow(
      "Forbidden",
    )

    expect(dimensionGrantStore.grantsByUser["user-1"]?.["mail:inbox"]?.direct).toEqual(["acc-1"])
    expect(dimensionGrantStore.error).toBe("Forbidden")
  })
})
