// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("mail-draft-store", () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const mod = await import("~/modules/mail/mail-draft-store")
    mod.resetMailDraftStore()
  })

  it("loadDrafts hydrates drafts and the reply lookup index", async () => {
    const api = {
      get: vi.fn().mockResolvedValue([
        {
          id: "d1",
          accountId: "mail-1",
          conversationId: "c1",
          replyToMessageId: null,
          to: [],
          cc: [],
          bcc: [],
          subject: "Reply",
          htmlBody: "",
          textBody: "",
          updatedAt: "2026-01-01",
        },
      ]),
    }

    const { getDraftForConversation, loadDrafts } = await import("~/modules/mail/mail-draft-store")
    await loadDrafts(api)
    expect(getDraftForConversation("c1")?.id).toBe("d1")
  })

  it("scheduleDraftSave uses an independent timer per draft", async () => {
    const api = {
      patch: vi.fn().mockResolvedValue(undefined),
    }

    const { scheduleDraftSave, upsertLocalDraft } = await import("~/modules/mail/mail-draft-store")
    upsertLocalDraft({
      id: "d1",
      accountId: "mail-1",
      conversationId: null,
      replyToMessageId: null,
      to: [],
      cc: [],
      bcc: [],
      subject: "A",
      htmlBody: "",
      textBody: "",
      updatedAt: "2026-01-01",
    })
    upsertLocalDraft({
      id: "d2",
      accountId: "mail-1",
      conversationId: null,
      replyToMessageId: null,
      to: [],
      cc: [],
      bcc: [],
      subject: "B",
      htmlBody: "",
      textBody: "",
      updatedAt: "2026-01-01",
    })

    scheduleDraftSave(api, "d1", { subject: "A1" })
    scheduleDraftSave(api, "d2", { subject: "B1" })

    await vi.advanceTimersByTimeAsync(2500)

    expect(api.patch).toHaveBeenCalledTimes(2)
  })

  // The body is kept as written; its email HTML is made once, for the save
  // that goes out, from the last keystroke's markdown.
  it("scheduleDraftSave saves a markdown body with its email HTML", async () => {
    const api = { patch: vi.fn().mockResolvedValue(undefined) }
    const { drafts, scheduleDraftSave, upsertLocalDraft } = await import(
      "~/modules/mail/mail-draft-store"
    )
    upsertLocalDraft({
      id: "d1",
      accountId: "mail-1",
      conversationId: null,
      replyToMessageId: null,
      to: [],
      cc: [],
      bcc: [],
      subject: "A",
      htmlBody: "<p>old</p>",
      textBody: "old",
      updatedAt: "2026-01-01",
    })

    scheduleDraftSave(api, "d1", { markdown: "Bonjour" })
    scheduleDraftSave(api, "d1", { subject: "S", markdown: "Bonjour **Anna**" })
    expect(drafts().d1).toMatchObject({ textBody: "Bonjour **Anna**", htmlBody: "" })

    await vi.advanceTimersByTimeAsync(2500)

    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(api.patch).toHaveBeenCalledWith("/mail/drafts/d1", {
      subject: "S",
      textBody: "Bonjour **Anna**",
      htmlBody: '<p style="margin:0 0 1em">Bonjour <strong>Anna</strong></p>',
    })
  })
})
