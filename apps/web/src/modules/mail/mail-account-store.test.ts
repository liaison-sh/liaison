// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("mail-account-store", () => {
  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("~/modules/mail/mail-account-store")
    mod.resetMailAccountStore()
  })

  it("loadAccounts populates store from API", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([
        {
          id: "mail-1",
          connectedAccountId: "conn-1",
          provider: "gmail",
          emailAddress: "user@gmail.com",
          displayName: "User",
          ownerType: "user",
          ownerId: "user-1",
          syncStatus: "idle",
          lastSyncAt: null,
          lastSyncError: null,
          unreadCount: 3,
          allowedImageSenderDomains: [],
        },
        {
          id: "mail-2",
          connectedAccountId: "conn-2",
          provider: "imap",
          emailAddress: "team@acme.com",
          displayName: "Team",
          ownerType: "org",
          ownerId: null,
          syncStatus: "syncing",
          lastSyncAt: null,
          lastSyncError: null,
          unreadCount: 1,
          allowedImageSenderDomains: ["example.com"],
        },
      ]),
      post: vi.fn(),
    }

    const { loadAccounts, allAccounts, personalAccounts, sharedAccounts } = await import(
      "~/modules/mail/mail-account-store"
    )

    await loadAccounts(api)

    expect(api.get).toHaveBeenCalledWith("/mail/accounts")
    expect(allAccounts()).toHaveLength(2)
    expect(personalAccounts()).toHaveLength(1)
    expect(sharedAccounts()).toHaveLength(1)
  })

  it("handleAccountEvent merges updates into an existing account", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([
        {
          id: "mail-1",
          connectedAccountId: "conn-1",
          provider: "gmail",
          emailAddress: "user@gmail.com",
          displayName: "User",
          ownerType: "user",
          ownerId: "user-1",
          syncStatus: "idle",
          lastSyncAt: null,
          lastSyncError: null,
          unreadCount: 0,
          allowedImageSenderDomains: [],
        },
      ]),
      post: vi.fn(),
    }

    const { getAccount, handleAccountEvent, loadAccounts } = await import(
      "~/modules/mail/mail-account-store"
    )
    await loadAccounts(api)

    handleAccountEvent("update", { id: "mail-1", syncStatus: "error", lastSyncError: "Timeout" })

    expect(getAccount("mail-1")?.syncStatus).toBe("error")
    expect(getAccount("mail-1")?.lastSyncError).toBe("Timeout")
  })

  it("resetMailAccountStore clears state", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([
        {
          id: "mail-1",
          connectedAccountId: "conn-1",
          provider: "gmail",
          emailAddress: "user@gmail.com",
          displayName: "User",
          ownerType: "user",
          ownerId: "user-1",
          syncStatus: "idle",
          lastSyncAt: null,
          lastSyncError: null,
          unreadCount: 0,
          allowedImageSenderDomains: [],
        },
      ]),
      post: vi.fn(),
    }

    const { allAccounts, loadAccounts, resetMailAccountStore } = await import(
      "~/modules/mail/mail-account-store"
    )
    await loadAccounts(api)
    expect(allAccounts()).toHaveLength(1)

    resetMailAccountStore()
    expect(allAccounts()).toEqual([])
  })

  it("allowSenderImageDomain normalizes and stores the returned sender domains", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([
        {
          id: "mail-1",
          connectedAccountId: "conn-1",
          provider: "gmail",
          emailAddress: "user@gmail.com",
          displayName: "User",
          ownerType: "user",
          ownerId: "user-1",
          syncStatus: "idle",
          lastSyncAt: null,
          lastSyncError: null,
          unreadCount: 0,
          allowedImageSenderDomains: [],
        },
      ]),
      post: vi.fn().mockResolvedValue({ allowedImageSenderDomains: ["images.example.com"] }),
    }

    const { allowSenderImageDomain, getAccount, loadAccounts } = await import(
      "~/modules/mail/mail-account-store"
    )
    await loadAccounts(api)
    await allowSenderImageDomain(api, "mail-1", "Images.Example.com")

    expect(api.post).toHaveBeenCalledWith("/mail/accounts/mail-1/image-preferences", {
      senderDomain: "images.example.com",
    })
    expect(getAccount("mail-1")?.allowedImageSenderDomains).toEqual(["images.example.com"])
  })
})
