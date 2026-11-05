// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, mock } from "bun:test"
import {
  attachFilesToParent,
  attachFileToParent,
  buildAttachmentSummaryLines,
  describeFileOrigin,
  type FileOrigin,
  isBlockedFileType,
} from "./attach"
import { FileServiceError } from "./service"

const ORG = "00000000-0000-0000-0000-000000000001"
const USER = "00000000-0000-0000-0000-000000000002"
const SRC = "00000000-0000-0000-0000-0000000000aa"
const DEST_ENTITY = "00000000-0000-0000-0000-0000000000bb"

// kernel/message is a built-in `fileParent` (no manifest registry needed) —
// keeps this a pure unit test.
const TARGET = { app: "kernel", entityType: "message", entityId: DEST_ENTITY }

/** Extract the raw SQL text from a drizzle `sql` object so a mock can branch
 *  on which query is running rather than fragile call-ordinal counting. */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? []
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown }).value
      return Array.isArray(v) ? v.join("") : ""
    })
    .join(" ")
    .toLowerCase()
}

function makeDeps(
  over: {
    srcRow?: Record<string, unknown>
    sourceVisible?: boolean
    destVisible?: boolean
    idempotentHit?: boolean
    scopes?: string[]
    sumTotal?: number
    insertThrows?: unknown
  } = {},
) {
  const inserted: Record<string, unknown>[] = []
  const copied: { sourceKey: string; destKey: string }[] = []
  const events: Record<string, unknown>[] = []
  const srcRow = {
    id: SRC,
    app: "tickets",
    entityType: "message",
    entityId: "t-msg-1",
    filename: "return-label.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    storageKey: "orgs/o/tickets/message/t-msg-1/x/return-label.pdf",
    disposition: "attachment",
    contentId: null,
    ordinal: 0,
    ...(over.srcRow ?? {}),
  }
  const rlsTx = {
    execute: mock(async (q: unknown) => {
      const t = sqlText(q)
      // lockLiveParent on a message destination (kernel.lock_live_message).
      if (t.includes("lock_live_message")) return [{ ok: true }]
      if (t === "") return []
      if (t.includes("sum(size_bytes)")) {
        return [{ total: String(over.sumTotal ?? 0) }]
      }
      if (t.includes(".files") && t.includes("where id")) {
        // attachFileToParent source SELECT.
        return over.sourceVisible === false ? [] : [srcRow]
      }
      // assertParentVisible — destination parent row lookup.
      return over.destVisible === false ? [] : [{ id: DEST_ENTITY }]
    }),
  }
  const privileged = async <T>(reason: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    if (reason.includes("precheck")) {
      return fn({
        execute: mock(async (q: unknown) => {
          const t = sqlText(q)
          if (t.includes("copied_from_id")) {
            return over.idempotentHit ? [{ id: "existing-file" }] : []
          }
          if (t.includes("settings")) return [{ settings: {} }]
          return [{ total: "0" }]
        }),
      })
    }
    if (reason.includes("dedup")) {
      return fn({
        execute: mock(async () => [{ id: "existing-file" }]),
      })
    }
    return fn({
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            if (over.insertThrows) throw over.insertThrows
            inserted.push(v)
            return [{ id: "new-file-id", ...v, createdAt: new Date() }]
          },
        }),
      }),
      queueEvent: async (e: Record<string, unknown>) => {
        events.push(e)
      },
    })
  }
  return {
    inserted,
    copied,
    events,
    deps: {
      rlsTx,
      privileged,
      orgId: ORG,
      userId: USER,
      actorType: "agent",
      scopes: over.scopes ?? ["kernel:threads:write"],
      copyObject: async (a: { sourceKey: string; destKey: string }) => {
        copied.push(a)
      },
    } as never,
  }
}

describe("isBlockedFileType", () => {
  it("blocks an executable by extension", () => {
    expect(isBlockedFileType("payload.exe", "application/pdf")).toBe(true)
  })

  it("blocks a double extension on the inner segment", () => {
    // `payload.exe.pdf` must not slip past on its benign-looking final ext.
    expect(isBlockedFileType("payload.exe.pdf", "application/pdf")).toBe(true)
  })

  it("blocks a Windows shortcut / autorun vector", () => {
    expect(isBlockedFileType("invoice.lnk", "")).toBe(true)
    expect(isBlockedFileType("setup.hta", "")).toBe(true)
  })

  it("blocks by MIME even with a benign extension", () => {
    expect(isBlockedFileType("notes", "application/x-msdownload")).toBe(true)
  })

  it("allows an ordinary document and an HTML attachment", () => {
    expect(isBlockedFileType("return-label.pdf", "application/pdf")).toBe(false)
    expect(isBlockedFileType("invoice.html", "text/html")).toBe(false)
  })

  describe("LIAISON_ATTACHMENT_ALLOW_EXTENSIONS override", () => {
    it("lifts an allow-listed extension off the denylist", () => {
      expect(
        isBlockedFileType("installer.exe", "application/octet-stream", {
          staffAuthored: true,
          allowExtensionsOverride: "exe,pkg,dmg",
        }),
      ).toBe(false)
    })

    it("also lifts the matching MIME block for the allow-listed extension", () => {
      // Without the override, application/x-msdownload alone is enough to block.
      expect(isBlockedFileType("notes", "application/x-msdownload")).toBe(true)
      expect(
        isBlockedFileType("notes", "application/x-msdownload", {
          staffAuthored: true,
          allowExtensionsOverride: "exe",
        }),
      ).toBe(false)
    })

    it("does not lift extensions outside the override list", () => {
      expect(
        isBlockedFileType("payload.bat", "application/octet-stream", {
          staffAuthored: true,
          allowExtensionsOverride: "exe,pkg,dmg",
        }),
      ).toBe(true)
    })

    it("ignores an empty override (falls back to the full denylist)", () => {
      expect(
        isBlockedFileType("installer.exe", "application/octet-stream", {
          staffAuthored: true,
          allowExtensionsOverride: "",
        }),
      ).toBe(true)
    })

    it("applies only to files staff authored: a file from outside keeps the full denylist", () => {
      expect(
        isBlockedFileType("installer.exe", "application/octet-stream", {
          allowExtensionsOverride: "exe",
        }),
      ).toBe(true)
      expect(
        isBlockedFileType("notes", "application/x-msdownload", {
          staffAuthored: false,
          allowExtensionsOverride: "exe",
        }),
      ).toBe(true)
    })

    it("still blocks a double extension not itself allow-listed", () => {
      expect(
        isBlockedFileType("payload.exe.bat", "application/pdf", {
          staffAuthored: true,
          allowExtensionsOverride: "exe",
        }),
      ).toBe(true)
    })
  })
})

describe("attachFileToParent", () => {
  it("copies a visible source file onto the destination parent", async () => {
    const h = makeDeps()
    const res = await attachFileToParent({ sourceFileId: SRC, target: TARGET }, h.deps)
    expect(res.id).toBe("new-file-id")
    expect(res.filename).toBe("return-label.pdf")
    expect(h.copied).toHaveLength(1)
    expect(h.inserted[0].copiedFromId).toBe(SRC)
    expect(h.inserted[0].entityId).toBe(DEST_ENTITY)
    expect(h.inserted[0].app).toBe("kernel")
    expect(h.events[0]).toMatchObject({ entity: "file", action: "create" })
  })

  it("rejects a source file the caller cannot see under RLS", async () => {
    const h = makeDeps({ sourceVisible: false })
    await expect(
      attachFileToParent({ sourceFileId: SRC, target: TARGET }, h.deps),
    ).rejects.toMatchObject({ code: "PARENT_NOT_FOUND" })
  })

  it("rejects when the destination parent row is not visible", async () => {
    const h = makeDeps({ destVisible: false })
    await expect(
      attachFileToParent({ sourceFileId: SRC, target: TARGET }, h.deps),
    ).rejects.toMatchObject({ code: "PARENT_NOT_FOUND" })
    expect(h.copied).toHaveLength(0)
  })

  it("rejects when the caller lacks the destination write scope", async () => {
    const h = makeDeps({ scopes: ["kernel:threads:read"] })
    await expect(
      attachFileToParent({ sourceFileId: SRC, target: TARGET }, h.deps),
    ).rejects.toBeInstanceOf(FileServiceError)
    expect(h.copied).toHaveLength(0)
  })

  it("is idempotent — returns the existing copy instead of re-copying", async () => {
    const h = makeDeps({ idempotentHit: true })
    const res = await attachFileToParent({ sourceFileId: SRC, target: TARGET }, h.deps)
    expect(res.id).toBe("existing-file")
    expect(h.copied).toHaveLength(0)
  })

  it("recovers from a concurrent-race unique violation by re-reading the winner", async () => {
    const dupErr = Object.assign(new Error("duplicate key"), { code: "23505" })
    const h = makeDeps({ insertThrows: dupErr })
    const res = await attachFileToParent({ sourceFileId: SRC, target: TARGET }, h.deps)
    // The loser's INSERT raised 23505; the dedup re-read returns the winner.
    expect(res.id).toBe("existing-file")
  })

  it("rethrows a non-unique-violation insert error", async () => {
    const h = makeDeps({ insertThrows: new Error("connection reset") })
    await expect(attachFileToParent({ sourceFileId: SRC, target: TARGET }, h.deps)).rejects.toThrow(
      /connection reset/,
    )
  })

  it("rejects an executable / script file type via the denylist", async () => {
    const h = makeDeps({
      srcRow: { filename: "payload.exe", mimeType: "application/x-msdownload" },
    })
    await expect(
      attachFileToParent({ sourceFileId: SRC, target: TARGET }, h.deps),
    ).rejects.toMatchObject({ code: "UNSAFE_FILE_TYPE" })
    expect(h.copied).toHaveLength(0)
  })

  it("allows an HTML attachment — downloaded, not rendered inline, so not blocked", async () => {
    const h = makeDeps({ srcRow: { filename: "invoice.html", mimeType: "text/html" } })
    const res = await attachFileToParent({ sourceFileId: SRC, target: TARGET }, h.deps)
    expect(res.id).toBe("new-file-id")
    expect(h.copied).toHaveLength(1)
  })

  it("emits a file:create event carrying copy provenance and the agent actor type", async () => {
    const h = makeDeps()
    await attachFileToParent({ sourceFileId: SRC, target: TARGET }, h.deps)
    expect(h.events[0]).toMatchObject({ actorType: "agent" })
    expect(h.events[0].data).toMatchObject({
      copiedFromId: SRC,
      sourceApp: "tickets",
      actorType: "agent",
    })
  })
})

describe("attachFilesToParent", () => {
  it("enforces the per-call count cap", async () => {
    const h = makeDeps()
    const ids = Array.from({ length: 11 }, (_, i) => `id-${i}`)
    await expect(
      attachFilesToParent({ sourceFileIds: ids, target: TARGET }, h.deps),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" })
  })

  it("rejects an over-cap batch before any copy is issued", async () => {
    // Pre-summed source size exceeds the 25 MB cumulative cap.
    const h = makeDeps({ sumTotal: 30 * 1024 * 1024 })
    await expect(
      attachFilesToParent({ sourceFileIds: [SRC, SRC], target: TARGET }, h.deps),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" })
    // The cap is checked up front — nothing was copied.
    expect(h.copied).toHaveLength(0)
  })

  it("copies each file and returns the summaries in order", async () => {
    const h = makeDeps({ sumTotal: 4096 })
    const res = await attachFilesToParent({ sourceFileIds: [SRC, SRC], target: TARGET }, h.deps)
    expect(res).toHaveLength(2)
    expect(res[0].filename).toBe("return-label.pdf")
    expect(h.copied).toHaveLength(2)
  })
})

describe("describeFileOrigin", () => {
  function rlsWith(row: Record<string, unknown> | null) {
    return { execute: mock(async () => (row ? [row] : [])) } as never
  }

  it("resolves a conversational parent and a human label", async () => {
    const origin = await describeFileOrigin(
      "f1",
      rlsWith({
        filename: "return-label.pdf",
        app: "tickets",
        entityType: "message",
        entityId: "tm-1",
        sessionApp: null,
      }),
      ORG,
    )
    expect(origin?.filename).toBe("return-label.pdf")
    expect(origin?.parent).toMatchObject({ app: "tickets", entityType: "message" })
    expect(origin?.label).toMatch(/ticket/i)
    expect(origin?.kind).toBe("conversational")
  })

  it("labels a Boxtal return-label (parented to a shipment) as a Boxtal-shipment SOURCE", async () => {
    // draft-rma-reply-with-return-label-attach: the prepared Boxtal return label is a kernel.files row
    // parented to (boxtal, shipment, …). It is deliberately-fetched shipping material, never a customer
    // conversation, so it must resolve as a `source` origin (never ⚠-flagged when attached to a reply)
    // and read "from a Boxtal shipment" — not the bare app string "boxtal".
    const origin = await describeFileOrigin(
      "f1",
      rlsWith({
        filename: "Return-Label-RMA-Mason-Reed.pdf",
        app: "boxtal",
        entityType: "shipment",
        entityId: "ship-1",
        sessionApp: null,
      }),
      ORG,
    )
    expect(origin?.label).toBe("a Boxtal shipment")
    expect(origin?.kind).toBe("source")
  })

  it("labels a Drive-imported file as 'Google Drive' and marks it a source", async () => {
    const origin = await describeFileOrigin(
      "f1",
      rlsWith({
        filename: "Q3 Report.pdf",
        app: "kernel",
        entityType: "file_upload_session",
        entityId: "sess-1",
        sessionApp: "google-drive",
      }),
      ORG,
    )
    expect(origin?.label).toBe("Google Drive")
    expect(origin?.kind).toBe("source")
  })

  it("returns null for a file the caller cannot see", async () => {
    expect(await describeFileOrigin("f1", rlsWith(null), ORG)).toBeNull()
  })
})

describe("buildAttachmentSummaryLines", () => {
  function rlsWith(row: Record<string, unknown> | null) {
    return { execute: mock(async () => (row ? [row] : [])) } as never
  }

  it("shows filename + origin and flags a cross-app origin with ⚠", async () => {
    const lines = await buildAttachmentSummaryLines(["f1"], {
      rlsTx: rlsWith({
        filename: "invoice.pdf",
        app: "tickets",
        entityType: "message",
        entityId: "tm-9",
        sessionApp: null,
      }),
      orgId: ORG,
      surfaceApp: "mail",
    })
    expect(lines[0]).toContain("📎")
    expect(lines[0]).toContain("invoice.pdf")
    expect(lines[0]).toContain("⚠")
  })

  it("flags a SAME-APP attachment from a different conversation with ⚠", async () => {
    // The cross-customer-leak case: a file from ticket B attached to a reply
    // on ticket A — same app, different conversation.
    const lines = await buildAttachmentSummaryLines(["f1"], {
      rlsTx: rlsWith({
        filename: "other-customer.pdf",
        app: "tickets",
        entityType: "message",
        entityId: "tm-from-B",
        sessionApp: null,
      }),
      orgId: ORG,
      surfaceApp: "tickets",
      replyTargetRootId: "ticket-A",
      resolveOriginRoot: async (_o: FileOrigin) => "ticket-B",
    })
    expect(lines[0]).toContain("other-customer.pdf")
    expect(lines[0]).toContain("⚠")
  })

  it("does NOT flag a same-app attachment from the same conversation", async () => {
    const lines = await buildAttachmentSummaryLines(["f1"], {
      rlsTx: rlsWith({
        filename: "thread-doc.pdf",
        app: "tickets",
        entityType: "message",
        entityId: "tm-from-A",
        sessionApp: null,
      }),
      orgId: ORG,
      surfaceApp: "tickets",
      replyTargetRootId: "ticket-A",
      resolveOriginRoot: async (_o: FileOrigin) => "ticket-A",
    })
    expect(lines[0]).toContain("thread-doc.pdf")
    expect(lines[0]).not.toContain("⚠")
  })

  it("never flags a deliberately-imported source file (Drive import)", async () => {
    const lines = await buildAttachmentSummaryLines(["f1"], {
      rlsTx: rlsWith({
        filename: "Q3 Report.pdf",
        app: "kernel",
        entityType: "file_upload_session",
        entityId: "sess-1",
        sessionApp: "google-drive",
      }),
      orgId: ORG,
      surfaceApp: "mail",
      replyTargetRootId: "conv-A",
      resolveOriginRoot: async () => null,
    })
    expect(lines[0]).toContain("Google Drive")
    expect(lines[0]).not.toContain("⚠")
  })

  it("lists a Boxtal return label on a mail reply WITHOUT a ⚠ flag (cross-app source, not a leak)", async () => {
    // The RMA reply attaches a return label sourced from a Boxtal shipment onto Mason's MAIL
    // conversation. Even though the file's app (boxtal) differs from the surface app (mail), it is a
    // deliberately-fetched shipping SOURCE — the approval summary must show its filename + "from a
    // Boxtal shipment" origin but NOT the ⚠ cross-customer-leak flag reserved for conversational files.
    const lines = await buildAttachmentSummaryLines(["f1"], {
      rlsTx: rlsWith({
        filename: "Return-Label-RMA-Mason-Reed.pdf",
        app: "boxtal",
        entityType: "shipment",
        entityId: "ship-1",
        sessionApp: null,
      }),
      orgId: ORG,
      surfaceApp: "mail",
      replyTargetRootId: "conv-mason",
      resolveOriginRoot: async () => null,
    })
    expect(lines[0]).toContain("Return-Label-RMA-Mason-Reed.pdf")
    expect(lines[0]).toContain("a Boxtal shipment")
    expect(lines[0]).not.toContain("⚠")
  })

  it("renders a @ref token as a placeholder", async () => {
    const lines = await buildAttachmentSummaryLines(
      ["@ref:11111111-1111-4111-8111-111111111111:label_pdf"],
      { rlsTx: rlsWith(null), orgId: ORG, surfaceApp: "tickets" },
    )
    expect(lines[0]).toMatch(/step|earlier/i)
  })

  it("renders an unavailable file without crashing", async () => {
    const lines = await buildAttachmentSummaryLines(["missing"], {
      rlsTx: rlsWith(null),
      orgId: ORG,
      surfaceApp: "mail",
    })
    expect(lines[0]).toMatch(/unavailable/i)
  })
})
