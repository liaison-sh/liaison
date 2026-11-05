// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
import path from "node:path"
import { executeInSandbox } from "~/apps/mail/test-page-write-bridge"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { getSandboxPool, initSandboxPool } from "~/modules/apps/sandbox/pool"

/**
 * A synthetic stand-in for the host's `mailbox_sealAndInsert`, for the sync
 * tests whose subject is paging, pacing and dedup rather than encryption.
 *
 * It mimics the real contract: the plaintext never reaches the row, and the
 * caller gets back key material plus one ciphertext column per sealed field.
 * It deliberately produces FAKE ciphertext, so nothing here can be mistaken for
 * a test of the crypto. The real bridge, against a real enrolled identity, is
 * exercised by T-INT-1 in `src/tests/integration/mail-sync.test.ts`.
 */
async function stubSealAndInsert(bridge: Record<string, any>, paramsJson: string): Promise<string> {
  const params = JSON.parse(paramsJson)
  // Record the plaintext the caller HANDED to the seal, under `data`, so a test
  // asserting "the right subject reached the writer" still can. The row itself
  // never carries it, which is the point of the whole phase.
  const inserted = JSON.parse(
    await bridge.db_insert(
      params.entity,
      JSON.stringify({ ...params.row, __sealedPlaintext: params.plaintext ?? {} }),
    ),
  )
  delete inserted.__sealedPlaintext
  const sealed: Record<string, string> = {}
  for (const [field, value] of Object.entries(params.plaintext ?? {})) {
    if (typeof value !== "string" || value === "") continue
    const column = `${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_ciphertext`
    sealed[column] = Buffer.from(`sealed:${value}`).toString("base64")
  }
  return JSON.stringify({
    ...inserted,
    subject: null,
    text_body: null,
    html_body: null,
    snippet: null,
    ...sealed,
    content_key_wrapped: Buffer.from("wrapped").toString("base64"),
    content_key_epk: Buffer.from("epk").toString("base64"),
    enc_key_id: 1,
    enc_version: 1,
  })
}

describe("gmailInitialSync handler", () => {
  let bundleSource: string

  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  })

  function createMockBridge(overrides: Record<string, any> = {}) {
    const updates: any[] = []
    const inserts: any[] = []
    const emits: any[] = []
    const fetches: string[] = []
    const jobs: any[] = []

    const account = {
      id: "acc-1",
      owner_type: "user",
      // Enrolled personal mailbox. Sync is suspended for a personal account
      // whose encryption_state is not "ready" (Task 4.4), so a sync fixture
      // must say which side of that line it is on.
      encryption_state: "ready",
      owner_id: "user-1",
      provider: "gmail",
      email_address: "test@gmail.com",
      sync_status: "pre-sync",
      sync_state: null,
      disconnected_at: null,
    }

    const initialBridge: Record<string, any> = {
      getUserId: () => "system:mail:gmailInitialSync",
      getOrgId: () => "org-1",
      db_findOne: async (_entity: string, id: string) => {
        if (id === "acc-1") return JSON.stringify(account)
        return JSON.stringify(null)
      },
      db_findMany: async () => JSON.stringify([]),
      mailbox_sealAndInsert: async (paramsJson: string) =>
        stubSealAndInsert(initialBridge, paramsJson),
      db_insert: async (entity: string, dataJson: string) => {
        const data = JSON.parse(dataJson)
        inserts.push({ entity, data })
        return JSON.stringify({ id: `gen-${inserts.length}`, ...data })
      },
      db_update: async (entity: string, id: string, dataJson: string) => {
        updates.push({ entity, id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async (eventJson: string) => {
        emits.push(JSON.parse(eventJson))
      },
      enqueueJob: async (name: string, payload: string) => {
        jobs.push({ name, payload: JSON.parse(payload) })
      },
      connections_getToken: async () => "mock-access-token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (paramsJson: string) => {
        const data = JSON.parse(paramsJson)
        return JSON.stringify({ id: "contact-1", email: data.email })
      },
      fetch: async (url: string, _optsJson?: string) => {
        fetches.push(url)
        if (url.includes("messages?")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({ messages: [{ id: "gmsg-1", threadId: "gthread-1" }] }),
          })
        }
        if (url.includes("messages/gmsg-1")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              id: "gmsg-1",
              threadId: "gthread-1",
              labelIds: ["INBOX"],
              payload: {
                headers: [
                  { name: "From", value: "alice@example.com" },
                  { name: "To", value: "bob@example.com" },
                  { name: "Subject", value: "Test Email" },
                  { name: "Date", value: "Mon, 15 Jan 2026 10:00:00 +0000" },
                  { name: "Message-ID", value: "<gmsg-1@mail.gmail.com>" },
                ],
                parts: [{ mimeType: "text/plain", body: { data: btoa("Hello from Gmail") } }],
              },
              internalDate: "1737018000000",
            }),
          })
        }
        if (url.includes("/watch")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({ historyId: "12345", expiration: "1737100000000" }),
          })
        }
        return JSON.stringify({ status: 404, headers: {}, body: "" })
      },
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      // Push topic configured by default so the watch path is exercised;
      // individual tests override to null for the poll-only fallback.
      config_get: async (key: string) =>
        key === "gmailPushTopic" ? "projects/test/topics/gmail-push" : null,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
      ...overrides,
    }
    return {
      bridge: initialBridge,
      updates,
      inserts,
      emits,
      fetches,
      jobs,
    }
  }

  it("syncs messages and updates sync status to active", async () => {
    const mock = createMockBridge()

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
      timeoutMs: 15000,
    })

    expect(mock.updates.find((update) => update.data.syncStatus === "syncing")).toBeDefined()
    expect(mock.updates.find((update) => update.data.syncStatus === "active")).toBeDefined()
    expect(mock.fetches.some((fetchUrl) => fetchUrl.includes("messages?"))).toBe(true)
    expect(mock.fetches.some((fetchUrl) => fetchUrl.includes("messages/gmsg-1"))).toBe(true)
    expect(mock.inserts.some((insert) => insert.entity === "conversations")).toBe(true)
    expect(mock.inserts.some((insert) => insert.entity === "messages")).toBe(true)
    expect(mock.fetches.some((fetchUrl) => fetchUrl.includes("/watch"))).toBe(true)
  })

  it("imports a Gmail attachment that arrives as an attachmentId only (multipart/mixed, PDF parts)", async () => {
    // The MIME tree of a real inbound application mail, anonymised: Gmail's
    // format=full gives the text parts inline and every PDF as an
    // `attachmentId` with no bytes. Sync stored the message and dropped both
    // files, because only parts carrying decoded bytes were imported.
    const b64url = (text: string) => Buffer.from(text).toString("base64url")
    const pdfPart = (partId: string, filename: string, attachmentId: string, size: number) => ({
      partId,
      mimeType: "application/pdf",
      filename,
      headers: [
        { name: "Content-Type", value: `application/pdf; name="${filename}"` },
        { name: "Content-Disposition", value: `attachment; filename="${filename}"` },
        { name: "Content-Transfer-Encoding", value: "base64" },
        { name: "Content-ID", value: `<f_${attachmentId}>` },
      ],
      body: { attachmentId, size },
    })
    const imports: any[] = []
    const mock = createMockBridge({
      files_importFromUrl: async (argsJson: string) => {
        imports.push(JSON.parse(argsJson))
        return JSON.stringify({ id: `file-${imports.length}` })
      },
      fetch: async (url: string) => {
        if (url.includes("messages?")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({ messages: [{ id: "gmsg-cv", threadId: "gthread-cv" }] }),
          })
        }
        if (url.includes("/attachments/")) {
          throw new Error("attachment bytes must be downloaded host side, not through fetch")
        }
        if (url.includes("messages/gmsg-cv")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              id: "gmsg-cv",
              threadId: "gthread-cv",
              labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "INBOX"],
              internalDate: "1791127914000",
              payload: {
                partId: "",
                mimeType: "multipart/mixed",
                filename: "",
                headers: [
                  { name: "From", value: "Applicant <applicant@example.com>" },
                  { name: "To", value: "contact@example.com" },
                  { name: "Subject", value: "Candidature spontanee" },
                  { name: "Date", value: "Mon, 5 Oct 2026 09:31:54 +0200" },
                  { name: "Message-ID", value: "<cv-1@mail.gmail.com>" },
                  { name: "Content-Type", value: 'multipart/mixed; boundary="000000000000e2f3"' },
                ],
                body: { size: 0 },
                parts: [
                  {
                    partId: "0",
                    mimeType: "multipart/alternative",
                    filename: "",
                    headers: [
                      { name: "Content-Type", value: 'multipart/alternative; boundary="0000e2f0"' },
                    ],
                    body: { size: 0 },
                    parts: [
                      {
                        partId: "0.0",
                        mimeType: "text/plain",
                        filename: "",
                        headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
                        body: { size: 24, data: b64url("Please find my CV here.") },
                      },
                      {
                        partId: "0.1",
                        mimeType: "text/html",
                        filename: "",
                        headers: [{ name: "Content-Type", value: 'text/html; charset="UTF-8"' }],
                        body: { size: 34, data: b64url("<div>Please find my CV here.</div>") },
                      },
                    ],
                  },
                  pdfPart("1", "CV 2026.pdf", "ANGjdJ_cv", 208582),
                  pdfPart("2", "Cover letter 2026.pdf", "ANGjdJ_letter", 282410),
                ],
              },
            }),
          })
        }
        if (url.includes("/watch")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({ historyId: "12345", expiration: "1737100000000" }),
          })
        }
        return JSON.stringify({ status: 404, headers: {}, body: "" })
      },
    })

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
      timeoutMs: 15000,
    })

    const message = mock.inserts.find((insert) => insert.entity === "messages")
    expect(message).toBeDefined()
    const messageId = `gen-${mock.inserts.indexOf(message) + 1}`
    expect(imports).toHaveLength(2)
    expect(imports.map((args) => [args.filename, args.ordinal, args.contentId])).toEqual([
      ["CV 2026.pdf", 0, "f_ANGjdJ_cv"],
      ["Cover letter 2026.pdf", 1, "f_ANGjdJ_letter"],
    ])
    for (const args of imports) {
      expect(args.targetApp).toBe("mail")
      expect(args.targetEntityType).toBe("message")
      expect(args.targetEntityId).toBe(messageId)
      expect(args.mimeType).toBe("application/pdf")
      expect(args.disposition).toBe("attachment")
      expect(args.jsonBase64Field).toBe("data")
      expect(args.headers).toEqual({ Authorization: "Bearer mock-access-token" })
    }
    expect(imports[0].url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/gmsg-cv/attachments/ANGjdJ_cv",
    )
    expect(imports[1].url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/gmsg-cv/attachments/ANGjdJ_letter",
    )
  })

  describe("the stored body is the message, never an attachment (LIF-20)", () => {
    const b64url = (text: string) => Buffer.from(text).toString("base64url")
    const leaf = (mimeType: string, text: string, extra: Record<string, unknown> = {}) => ({
      mimeType,
      filename: "",
      headers: [{ name: "Content-Type", value: `${mimeType}; charset="UTF-8"` }],
      body: { size: text.length, data: b64url(text) },
      ...extra,
    })
    const fileLeaf = (mimeType: string, filename: string, text: string, disposition: string) =>
      leaf(mimeType, text, {
        filename,
        headers: [
          { name: "Content-Type", value: `${mimeType}; name="${filename}"` },
          { name: "Content-Disposition", value: `${disposition}; filename="${filename}"` },
        ],
      })

    /** Sync one Gmail message with this MIME tree; return the bodies handed to the writer. */
    async function storedBodies(payload: Record<string, unknown>) {
      const mock = createMockBridge({
        files_importAttachment: async () => JSON.stringify({ id: "file-1" }),
        files_importFromUrl: async () => JSON.stringify({ id: "file-2" }),
        fetch: async (url: string) => {
          if (url.includes("messages?")) {
            return JSON.stringify({
              status: 200,
              headers: {},
              body: JSON.stringify({ messages: [{ id: "gmsg-b", threadId: "gthread-b" }] }),
            })
          }
          if (url.includes("messages/gmsg-b")) {
            return JSON.stringify({
              status: 200,
              headers: {},
              body: JSON.stringify({
                id: "gmsg-b",
                threadId: "gthread-b",
                labelIds: ["INBOX"],
                internalDate: "1791127914000",
                payload: {
                  headers: [
                    { name: "From", value: "Sender <sender@example.com>" },
                    { name: "To", value: "contact@example.com" },
                    { name: "Subject", value: "Body test" },
                    { name: "Date", value: "Mon, 5 Oct 2026 09:31:54 +0200" },
                    { name: "Message-ID", value: "<body-1@mail.gmail.com>" },
                  ],
                  ...payload,
                },
              }),
            })
          }
          if (url.includes("/watch")) {
            return JSON.stringify({
              status: 200,
              headers: {},
              body: JSON.stringify({ historyId: "12345", expiration: "1737100000000" }),
            })
          }
          return JSON.stringify({ status: 404, headers: {}, body: "" })
        },
      })
      await executeInSandbox({
        pool: getSandboxPool(),
        bundleSource,
        exportName: "gmailInitialSync",
        params: { orgId: "org-1", accountId: "acc-1" },
        bridge: mock.bridge,
        timeoutMs: 15000,
      })
      const message = mock.inserts.find((insert) => insert.entity === "messages")
      const data = message?.data ?? {}
      return {
        text: String(data.textBody ?? data.__sealedPlaintext?.textBody ?? ""),
        html: String(data.htmlBody ?? data.__sealedPlaintext?.htmlBody ?? ""),
      }
    }

    it("a text or HTML file attached after the body does not replace the body", async () => {
      const bodies = await storedBodies({
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            filename: "",
            parts: [
              leaf("text/plain", "The real message."),
              leaf("text/html", "<div>The real message.</div>"),
            ],
          },
          fileLeaf("text/plain", "notes.txt", "ATTACHED NOTES", "attachment"),
          fileLeaf("text/html", "page.html", "<p>ATTACHED PAGE</p>", "attachment"),
        ],
      })
      expect(bodies.text).toBe("The real message.")
      expect(bodies.html).toBe("<div>The real message.</div>")
    })

    it("a body sent as an inline named text part is still the body", async () => {
      const named = leaf("text/plain", "Body carried by a named part.", {
        filename: "message.txt",
        headers: [
          { name: "Content-Type", value: 'text/plain; charset="UTF-8"; name="message.txt"' },
        ],
      })
      const bodies = await storedBodies(named)
      expect(bodies.text).toBe("Body carried by a named part.")
      const mixed = await storedBodies({
        mimeType: "multipart/mixed",
        parts: [named, fileLeaf("text/plain", "notes.txt", "ATTACHED NOTES", "attachment")],
      })
      expect(mixed.text).toBe("Body carried by a named part.")
    })

    it("an inline named text part does not join a message that has its own unnamed body", async () => {
      const bodies = await storedBodies({
        mimeType: "multipart/mixed",
        parts: [
          leaf("text/plain", "The real message."),
          leaf("text/plain", "INLINE NOTES", {
            filename: "notes.txt",
            headers: [{ name: "Content-Type", value: 'text/plain; name="notes.txt"' }],
          }),
        ],
      })
      expect(bodies.text).toBe("The real message.")
    })

    it("an HTML body split around an inline attachment keeps every fragment (Apple Mail)", async () => {
      const bodies = await storedBodies({
        mimeType: "multipart/alternative",
        parts: [
          leaf("text/plain", "Hello, the quote is attached.\n\nRegards"),
          {
            mimeType: "multipart/mixed",
            filename: "",
            parts: [
              leaf("text/html", "<html><body><div>Hello, the quote is attached.</div>"),
              {
                mimeType: "application/pdf",
                filename: "quote.pdf",
                headers: [
                  { name: "Content-Type", value: 'application/pdf; name="quote.pdf"' },
                  { name: "Content-Disposition", value: 'inline; filename="quote.pdf"' },
                ],
                body: { attachmentId: "ANG_quote", size: 90000 },
              },
              leaf("text/html", "<div>Regards</div></body></html>"),
            ],
          },
        ],
      })
      expect(bodies.html).toContain("Hello, the quote is attached.")
      expect(bodies.html).toContain("Regards")
      expect(bodies.text).toBe("Hello, the quote is attached.\n\nRegards")
    })

    it("a forwarded message attached as .eml does not replace the covering note", async () => {
      const bodies = await storedBodies({
        mimeType: "multipart/mixed",
        parts: [
          leaf("text/plain", "See the mail below."),
          {
            mimeType: "message/rfc822",
            filename: "",
            headers: [{ name: "Content-Type", value: "message/rfc822" }],
            body: { size: 0 },
            parts: [
              {
                mimeType: "multipart/alternative",
                filename: "",
                parts: [
                  leaf("text/plain", "INNER MESSAGE"),
                  leaf("text/html", "<p>INNER MESSAGE</p>"),
                ],
              },
            ],
          },
        ],
      })
      expect(bodies.text).toBe("See the mail below.")
      expect(bodies.html).toBe("")
    })
  })

  it("attachment backfill re-imports a stored message's Gmail files and skips what cannot need it", async () => {
    // Rows stored before the fix: a multipart/mixed message with no files
    // (the dropped CV), a multipart/alternative one (no file part possible),
    // and a multipart/mixed one that already has its file. Only the first
    // costs a Gmail fetch; nothing is imported twice.
    const now = Date.now()
    const rows = [
      {
        id: "msg-dropped",
        external_provider_id: "gmsg-dropped",
        sent_at: new Date(now - 60_000).toISOString(),
        raw_headers: { "content-type": 'multipart/mixed; boundary="a"' },
      },
      {
        id: "msg-plain",
        external_provider_id: "gmsg-plain",
        sent_at: new Date(now - 120_000).toISOString(),
        raw_headers: { "content-type": 'multipart/alternative; boundary="b"' },
      },
      {
        id: "msg-has-file",
        external_provider_id: "gmsg-has-file",
        sent_at: new Date(now - 180_000).toISOString(),
        raw_headers: { "content-type": 'multipart/mixed; boundary="c"' },
      },
    ]
    const imports: any[] = []
    const mock = createMockBridge({
      db_findOne: async (_entity: string, id: string) =>
        JSON.stringify(
          id === "acc-1"
            ? {
                id: "acc-1",
                owner_type: "org",
                owner_id: null,
                encryption_state: "none",
                provider: "gmail",
                email_address: "contact@example.com",
                sync_status: "active",
                disconnected_at: null,
              }
            : null,
        ),
      db_findMany: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson)
        if (entity === "messages" && opts.where?.direction === "inbound") {
          return JSON.stringify(rows.slice(opts.offset ?? 0, (opts.offset ?? 0) + opts.limit))
        }
        return JSON.stringify([])
      },
      files_listAttachments: async (parentJson: string) =>
        JSON.stringify(JSON.parse(parentJson).entityId === "msg-has-file" ? [{ ordinal: 0 }] : []),
      files_importFromUrl: async (argsJson: string) => {
        imports.push(JSON.parse(argsJson))
        return JSON.stringify({ id: `file-${imports.length}` })
      },
      fetch: async (url: string) => {
        mock.fetches.push(url)
        if (url.includes("messages/gmsg-dropped")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              id: "gmsg-dropped",
              threadId: "gthread-dropped",
              labelIds: ["INBOX"],
              payload: {
                mimeType: "multipart/mixed",
                headers: [{ name: "Message-ID", value: "<dropped@mail.gmail.com>" }],
                parts: [
                  {
                    partId: "0",
                    mimeType: "text/plain",
                    filename: "",
                    body: { size: 5, data: Buffer.from("hello").toString("base64url") },
                  },
                  {
                    partId: "1",
                    mimeType: "application/pdf",
                    filename: "CV.pdf",
                    headers: [
                      { name: "Content-Disposition", value: 'attachment; filename="CV.pdf"' },
                    ],
                    body: { attachmentId: "ANGjdJ_dropped", size: 1024 },
                  },
                ],
              },
            }),
          })
        }
        return JSON.stringify({ status: 404, headers: {}, body: "" })
      },
    })

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailAttachmentBackfill",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
      timeoutMs: 15000,
    })

    expect(mock.fetches).toEqual([
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/gmsg-dropped?format=full",
    ])
    expect(imports).toHaveLength(1)
    expect(imports[0]).toMatchObject({
      targetEntityId: "msg-dropped",
      filename: "CV.pdf",
      ordinal: 0,
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/gmsg-dropped/attachments/ANGjdJ_dropped",
      headers: { Authorization: "Bearer mock-access-token" },
    })
    // A short page is the last one: no paced successor.
    expect(mock.jobs.filter((job) => job.name === "gmail-attachment-backfill")).toHaveLength(0)
  })

  it("seeds historyId + watch UP FRONT on a multi-page backfill, before the chain completes", async () => {
    // messages.list pages a newest-first snapshot, so mail arriving DURING a
    // long backfill is only reachable via the history API. The cursor must be
    // seeded on the FIRST page job (not at completion) so the incremental sync
    // can deliver new mail in parallel with the import.
    const mock = createMockBridge({
      fetch: async (url: string) => {
        if (url.includes("messages?")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              messages: [{ id: "gmsg-1", threadId: "gthread-1" }],
              nextPageToken: "page-2",
            }),
          })
        }
        if (url.includes("messages/gmsg-1")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              id: "gmsg-1",
              threadId: "gthread-1",
              labelIds: ["INBOX"],
              payload: { headers: [{ name: "Subject", value: "x" }] },
              internalDate: "1737018000000",
            }),
          })
        }
        if (url.includes("/watch")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({ historyId: "777", expiration: "1737100000000" }),
          })
        }
        return JSON.stringify({ status: 404, headers: {}, body: "" })
      },
    })

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
      timeoutMs: 15000,
    })

    // Chain did NOT complete (nextPageToken -> re-enqueue), yet historyId is seeded.
    expect(mock.updates.find((u) => u.data.syncStatus === "active")).toBeUndefined()
    expect(mock.jobs.some((j) => j.name === "gmail-initial-sync")).toBe(true)
    const seeded = mock.updates.find((u) => u.data.syncState?.historyId === "777")
    expect(seeded).toBeDefined()
    // The page save stamps the chain's own liveness marker.
    expect(mock.updates.some((u) => typeof u.data.syncState?.pageSavedAt === "string")).toBe(true)
  })

  it("incremental scheduled tick also syncs a mid-backfill account with a seeded historyId", async () => {
    const jobs: any[] = []
    const updates: any[] = []
    const syncingAccount = {
      id: "acc-backfill",
      provider: "gmail",
      email_address: "backfill@gmail.com",
      sync_status: "syncing",
      sync_state: { cursor: "page-5", historyId: "500", pageSavedAt: new Date().toISOString() },
      disconnected_at: null,
      updated_at: new Date().toISOString(),
      last_sync_at: null,
    }
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async (_e: string, id: string) =>
        JSON.stringify(id === "acc-backfill" ? syncingAccount : null),
      db_findMany: async (entity: string, optsJson: string) => {
        if (entity !== "accounts") return JSON.stringify([])
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.syncStatus === "syncing") return JSON.stringify([syncingAccount])
        return JSON.stringify([])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async () => JSON.stringify({ id: "x" }),
      db_update: async (_e: string, id: string, dataJson: string) => {
        updates.push({ id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => JSON.stringify({ id: "c1" }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({ historyId: "600", history: [] }),
          })
        }
        return JSON.stringify({ status: 200, headers: {}, body: "{}" })
      },
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1" },
      bridge,
    })

    // The mid-backfill account was NOT re-enqueued for a duplicate initial sync
    // (its pageSavedAt is fresh) and its history was consumed incrementally,
    // advancing historyId while PRESERVING the chain's cursor.
    expect(jobs.find((j) => j.name === "gmail-initial-sync")).toBeUndefined()
    const write = updates.find((u) => u.id === "acc-backfill" && u.data.syncState?.historyId)
    expect(write).toBeDefined()
    expect(write?.data.syncState.historyId).toBe("600")
    expect(write?.data.syncState.cursor).toBe("page-5")
    expect(write?.data.syncStatus).toBeUndefined()
  })

  it("seeds historyId from users.getProfile when no push topic is configured", async () => {
    // Poll-only deployment (gmailPushTopic unset). The old code hardcoded a
    // wrong-project topic, watch failed, and the account finalized WITHOUT a
    // historyId -- so every incremental tick re-ran the full initial sync.
    const mock = createMockBridge({
      config_get: async () => null,
    })
    const baseFetch = mock.bridge.fetch
    mock.bridge.fetch = async (url: string, optsJson?: string) => {
      if (url.includes("/profile")) {
        mock.fetches.push(url)
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ emailAddress: "test@gmail.com", historyId: "777001" }),
        })
      }
      return baseFetch(url, optsJson)
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
      timeoutMs: 15000,
    })

    expect(mock.fetches.some((fetchUrl) => fetchUrl.includes("/watch"))).toBe(false)
    expect(mock.fetches.some((fetchUrl) => fetchUrl.includes("/profile"))).toBe(true)
    const finalized = mock.updates.find((update) => update.data.syncStatus === "active")
    expect(finalized).toBeDefined()
    expect(finalized!.data.syncState.historyId).toBe("777001")
  })

  it("registers the watch with the CONFIGURED topic, never a hardcoded one", async () => {
    const bodies: string[] = []
    const mock = createMockBridge()
    const baseFetch = mock.bridge.fetch
    mock.bridge.fetch = async (url: string, optsJson?: string) => {
      if (url.includes("/watch")) bodies.push(JSON.parse(optsJson ?? "{}").body)
      return baseFetch(url, optsJson)
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
      timeoutMs: 15000,
    })

    expect(bodies.length).toBe(1)
    expect(JSON.parse(bodies[0]).topicName).toBe("projects/test/topics/gmail-push")
  })

  it("paces the page chain: next-page re-enqueue carries a delay", async () => {
    // Full-history imports are thousands of pages; without the inter-page
    // delay the chain monopolizes the worker and hammers Gmail + the DB for
    // hours (system-overload guard).
    const jobsWithOpts: Array<{ name: string; opts: any }> = []
    const mock = createMockBridge({
      enqueueJob: async (name: string, _payload: string, opts?: string) => {
        jobsWithOpts.push({ name, opts: opts ? JSON.parse(opts) : null })
      },
    })
    const baseFetch = mock.bridge.fetch
    mock.bridge.fetch = async (url: string, optsJson?: string) => {
      if (url.includes("messages?")) {
        mock.fetches.push(url)
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({
            messages: [{ id: "gmsg-1", threadId: "gthread-1" }],
            nextPageToken: "page-2",
          }),
        })
      }
      return baseFetch(url, optsJson)
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
      timeoutMs: 15000,
    })

    const next = jobsWithOpts.find((job) => job.name === "gmail-initial-sync")
    expect(next).toBeDefined()
    expect(next!.opts?.delay).toBeGreaterThan(0)
  })

  it("exits cleanly when account is disconnected", async () => {
    const mock = createMockBridge({
      db_findOne: async () =>
        JSON.stringify({
          id: "acc-1",
          sync_status: "pre-sync",
          disconnected_at: "2026-01-01T00:00:00Z",
        }),
    })

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
    })

    expect(mock.fetches.length).toBe(0)
  })

  it("degrades one oversized message via metadata fallback and ingests the rest", async () => {
    // One message's format=full fetch throws the sandbox bridge size cap. The
    // page must still complete: the other message ingests fully, the oversized
    // one ingests degraded (metadata fallback, empty body + marker), and the
    // job logs the degraded count. A single bad message never kills the sync.
    const infoLogs: Array<{ msg: string; ctx: any }> = []
    const mock = createMockBridge({
      log_info: (msg: string, ctxJson?: string) => {
        infoLogs.push({ msg, ctx: ctxJson ? JSON.parse(ctxJson) : null })
      },
    })
    mock.bridge.fetch = async (url: string, _optsJson?: string) => {
      mock.fetches.push(url)
      if (url.includes("messages?")) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({
            messages: [
              { id: "gmsg-small", threadId: "gthread-1" },
              { id: "gmsg-big", threadId: "gthread-2" },
            ],
          }),
        })
      }
      if (url.includes("messages/gmsg-small")) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({
            id: "gmsg-small",
            threadId: "gthread-1",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "alice@example.com" },
                { name: "To", value: "bob@example.com" },
                { name: "Subject", value: "Small Email" },
                { name: "Date", value: "Mon, 15 Jan 2026 10:00:00 +0000" },
                { name: "Message-ID", value: "<gmsg-small@mail.gmail.com>" },
              ],
              parts: [{ mimeType: "text/plain", body: { data: btoa("Hello small") } }],
            },
            internalDate: "1737018000000",
          }),
        })
      }
      if (url.includes("messages/gmsg-big")) {
        // format=full throws the bridge cap; format=metadata succeeds.
        if (url.includes("format=metadata")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              id: "gmsg-big",
              threadId: "gthread-2",
              labelIds: ["INBOX"],
              snippet: "Big email preview",
              payload: {
                headers: [
                  { name: "From", value: "carol@example.com" },
                  { name: "To", value: "bob@example.com" },
                  { name: "Subject", value: "Big Email" },
                  { name: "Date", value: "Mon, 15 Jan 2026 11:00:00 +0000" },
                  { name: "Message-ID", value: "<gmsg-big@mail.gmail.com>" },
                ],
              },
              internalDate: "1737021600000",
            }),
          })
        }
        throw new Error("Response body exceeds 1000000 bytes")
      }
      if (url.includes("/watch")) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ historyId: "12345", expiration: "1737100000000" }),
        })
      }
      return JSON.stringify({ status: 404, headers: {}, body: "" })
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
      timeoutMs: 15000,
    })

    // Sync still finalized to active (job did NOT fail).
    expect(mock.updates.find((update) => update.data.syncStatus === "active")).toBeDefined()

    // The oversized message fell back to metadata.
    expect(
      mock.fetches.some(
        (url) => url.includes("messages/gmsg-big") && url.includes("format=metadata"),
      ),
    ).toBe(true)

    // Both messages ingested (small full, big degraded).
    const messageInserts = mock.inserts.filter((insert) => insert.entity === "messages")
    expect(messageInserts.length).toBe(2)
    const bigInsert = messageInserts.find(
      (insert) =>
        (insert.data.subject ?? insert.data.__sealedPlaintext?.subject ?? "") === "Big Email",
    )
    expect(bigInsert).toBeDefined()
    expect(bigInsert!.data.snippet ?? bigInsert!.data.__sealedPlaintext?.snippet).toContain(
      "attachment too large to sync",
    )
    expect(bigInsert!.data.textBody ?? bigInsert!.data.__sealedPlaintext?.textBody).toContain(
      "attachment too large to sync",
    )
    expect(
      (bigInsert!.data.htmlBody ?? bigInsert!.data.__sealedPlaintext?.htmlBody) === "" ||
        (bigInsert!.data.htmlBody ?? bigInsert!.data.__sealedPlaintext?.htmlBody) == null,
    ).toBe(true)

    // Degraded count reported in a completion log.
    const degradedLog = infoLogs.find((entry) => entry.ctx && entry.ctx.degraded === 1)
    expect(degradedLog).toBeDefined()
  })

  it("skips an oversized message when the metadata fallback also fails, page still completes", async () => {
    const mock = createMockBridge()
    mock.bridge.fetch = async (url: string, _optsJson?: string) => {
      mock.fetches.push(url)
      if (url.includes("messages?")) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({
            messages: [
              { id: "gmsg-small", threadId: "gthread-1" },
              { id: "gmsg-big", threadId: "gthread-2" },
            ],
          }),
        })
      }
      if (url.includes("messages/gmsg-small")) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({
            id: "gmsg-small",
            threadId: "gthread-1",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "alice@example.com" },
                { name: "To", value: "bob@example.com" },
                { name: "Subject", value: "Small Email" },
                { name: "Date", value: "Mon, 15 Jan 2026 10:00:00 +0000" },
                { name: "Message-ID", value: "<gmsg-small@mail.gmail.com>" },
              ],
              parts: [{ mimeType: "text/plain", body: { data: btoa("Hello small") } }],
            },
            internalDate: "1737018000000",
          }),
        })
      }
      if (url.includes("messages/gmsg-big")) {
        // Both format=full and format=metadata blow up.
        throw new Error("Response body exceeds 1000000 bytes")
      }
      if (url.includes("/watch")) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ historyId: "12345", expiration: "1737100000000" }),
        })
      }
      return JSON.stringify({ status: 404, headers: {}, body: "" })
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
      timeoutMs: 15000,
    })

    // Job completed (active), only the good message ingested.
    expect(mock.updates.find((update) => update.data.syncStatus === "active")).toBeDefined()
    const messageInserts = mock.inserts.filter((insert) => insert.entity === "messages")
    expect(messageInserts.length).toBe(1)
    expect(
      messageInserts[0].data.subject ?? messageInserts[0].data.__sealedPlaintext?.subject,
    ).toBe("Small Email")
  })

  it("resumes from cursor in syncState", async () => {
    const mock = createMockBridge({
      db_findOne: async () =>
        JSON.stringify({
          id: "acc-1",
          owner_type: "user",
          // Enrolled personal mailbox. Sync is suspended for a personal account
          // whose encryption_state is not "ready" (Task 4.4), so a sync fixture
          // must say which side of that line it is on.
          encryption_state: "ready",
          owner_id: "user-1",
          provider: "gmail",
          email_address: "test@gmail.com",
          sync_status: "syncing",
          disconnected_at: null,
          sync_state: { cursor: "page-token-2", messagesSynced: 100 },
        }),
    })

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
      timeoutMs: 15000,
    })

    expect(mock.fetches.some((fetchUrl) => fetchUrl.includes("pageToken=page-token-2"))).toBe(true)
  })

  it("already-stored messages in a messages.list page are skipped without a fetch, each new one processed individually", async () => {
    // A page of 3 message ids where 1 is already stored (a retried page after a
    // rollback/interrupt re-lists messages already ingested). Only the 2
    // not-yet-stored messages should be fetched, and each processed/upserted
    // individually (not batched) -- per-message immediate processing.
    const mock = createMockBridge({
      db_findMany: async (entity: string, optsJson: string) => {
        if (entity !== "messages") return JSON.stringify([])
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.externalProviderId === "gmsg-2") {
          return JSON.stringify([{ id: "already-stored" }])
        }
        return JSON.stringify([])
      },
    })
    mock.bridge.fetch = async (url: string, _optsJson?: string) => {
      mock.fetches.push(url)
      if (url.includes("messages?")) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({
            messages: [
              { id: "gmsg-1", threadId: "gthread-1" },
              { id: "gmsg-2", threadId: "gthread-2" },
              { id: "gmsg-3", threadId: "gthread-3" },
            ],
          }),
        })
      }
      const idm = url.match(/messages\/([^?]+)/)
      if (idm) {
        const id = idm[1]
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({
            id,
            threadId: `t-${id}`,
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "alice@example.com" },
                { name: "To", value: "bob@example.com" },
                { name: "Subject", value: `Subject ${id}` },
                { name: "Date", value: "Mon, 15 Jan 2026 10:00:00 +0000" },
                { name: "Message-ID", value: `<${id}@mail.gmail.com>` },
              ],
              parts: [{ mimeType: "text/plain", body: { data: btoa("body") } }],
            },
            internalDate: "1737018000000",
          }),
        })
      }
      if (url.includes("/watch")) {
        return JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({ historyId: "12345", expiration: "1737100000000" }),
        })
      }
      return JSON.stringify({ status: 404, headers: {}, body: "" })
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailInitialSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge: mock.bridge,
      timeoutMs: 15000,
    })

    // Only the 2 not-yet-stored messages (gmsg-1, gmsg-3) were fetched.
    const fetchedMessageIds = mock.fetches.filter((url) => /messages\/gmsg-\d/.test(url))
    expect(fetchedMessageIds.length).toBe(2)
    expect(fetchedMessageIds.some((url) => url.includes("gmsg-1"))).toBe(true)
    expect(fetchedMessageIds.some((url) => url.includes("gmsg-3"))).toBe(true)
    expect(fetchedMessageIds.some((url) => url.includes("gmsg-2"))).toBe(false)

    // Each fetched message was processed/upserted individually -- 2 separate
    // message inserts (not a single batched write).
    const messageInserts = mock.inserts.filter((insert) => insert.entity === "messages")
    expect(messageInserts.length).toBe(2)
    expect(
      messageInserts.some(
        (insert) =>
          insert.data.subject ?? insert.data.__sealedPlaintext?.subject === "Subject gmsg-1",
      ),
    ).toBe(true)
    expect(
      messageInserts.some(
        (insert) =>
          insert.data.subject ?? insert.data.__sealedPlaintext?.subject === "Subject gmsg-3",
      ),
    ).toBe(true)
  })
})

describe("gmailIncrementalSync handler", () => {
  let bundleSource: string

  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  })

  it("enqueues initial sync when active account has no historyId", async () => {
    const jobs: any[] = []
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () => JSON.stringify(null),
      // Filter-aware: the scheduled tick also sweeps pre-sync/syncing accounts
      // (stranded-initial rescue) with their own queries -- returning this
      // active account for those too would double-count the enqueue.
      db_findMany: async (_entity: string, optsJson: string) => {
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
        return JSON.stringify([
          {
            id: "acc-1",
            provider: "gmail",
            email_address: "test@gmail.com",
            sync_status: "active",
            sync_state: {},
            disconnected_at: null,
          },
        ])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async () => JSON.stringify({ id: "x" }),
      db_update: async () => {},
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => JSON.stringify({ id: "c1" }),
      fetch: async () => JSON.stringify({ status: 200, headers: {}, body: "{}" }),
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1" },
      bridge,
    })

    expect(jobs).toEqual([
      expect.objectContaining({
        name: "gmail-initial-sync",
        payload: { orgId: "org-1", accountId: "acc-1" },
        opts: { jobId: "gmail-initial-sync:acc-1" },
      }),
    ])
  })

  it("resets syncState and enqueues full sync when Gmail history is expired", async () => {
    const updates: any[] = []
    const jobs: any[] = []
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () =>
        JSON.stringify({
          id: "acc-1",
          provider: "gmail",
          email_address: "test@gmail.com",
          sync_status: "active",
          sync_state: { historyId: "123" },
          disconnected_at: null,
        }),
      db_findMany: async () => JSON.stringify([]),
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async () => JSON.stringify({ id: "x" }),
      db_update: async (_entity: string, id: string, dataJson: string) => {
        updates.push({ id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => JSON.stringify({ id: "c1" }),
      fetch: async () => JSON.stringify({ status: 404, headers: {}, body: JSON.stringify({}) }),
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
    })

    expect(
      updates.some((update) => JSON.stringify(update.data.syncState) === JSON.stringify({})),
    ).toBe(true)
    expect(jobs.some((job) => job.name === "gmail-initial-sync")).toBe(true)
  })

  it("degrades an oversized added message on the incremental history path", async () => {
    // A messageAdded whose format=full fetch throws the bridge size cap must
    // fall back to metadata (body-less + marker) and NOT crash the tick; the
    // account's lastSyncAt still advances.
    const inserts: any[] = []
    const updates: any[] = []
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () =>
        JSON.stringify({
          id: "acc-1",
          owner_type: "user",
          // Enrolled personal mailbox. Sync is suspended for a personal account
          // whose encryption_state is not "ready" (Task 4.4), so a sync fixture
          // must say which side of that line it is on.
          encryption_state: "ready",
          owner_id: "user-1",
          provider: "gmail",
          email_address: "test@gmail.com",
          sync_status: "active",
          sync_state: { historyId: "123" },
          disconnected_at: null,
        }),
      db_findMany: async (entity: string, optsJson: string) => {
        // Only the account sweep returns accounts; message/conversation lookups
        // must return empty so processMessages ingests the new message.
        if (entity !== "accounts") return JSON.stringify([])
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
        return JSON.stringify([
          {
            id: "acc-1",
            owner_type: "user",
            // Enrolled personal mailbox. Sync is suspended for a personal account
            // whose encryption_state is not "ready" (Task 4.4), so a sync fixture
            // must say which side of that line it is on.
            encryption_state: "ready",
            owner_id: "user-1",
            provider: "gmail",
            email_address: "test@gmail.com",
            sync_status: "active",
            sync_state: { historyId: "123" },
            disconnected_at: null,
          },
        ])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (entity: string, dataJson: string) => {
        inserts.push({ entity, data: JSON.parse(dataJson) })
        return JSON.stringify({ id: `gen-${inserts.length}`, ...JSON.parse(dataJson) })
      },
      db_update: async (_entity: string, id: string, dataJson: string) => {
        updates.push({ id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async () => {},
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (paramsJson: string) => {
        const data = JSON.parse(paramsJson)
        return JSON.stringify({ id: "contact-1", email: data.email })
      },
      fetch: async (url: string, _optsJson?: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              historyId: "200",
              history: [{ id: "150", messagesAdded: [{ message: { id: "gmsg-big" } }] }],
            }),
          })
        }
        if (url.includes("messages/gmsg-big")) {
          if (url.includes("format=metadata")) {
            return JSON.stringify({
              status: 200,
              headers: {},
              body: JSON.stringify({
                id: "gmsg-big",
                threadId: "gthread-9",
                labelIds: ["INBOX"],
                snippet: "Big incremental preview",
                payload: {
                  headers: [
                    { name: "From", value: "carol@example.com" },
                    { name: "To", value: "bob@example.com" },
                    { name: "Subject", value: "Big Incremental" },
                    { name: "Date", value: "Mon, 15 Jan 2026 12:00:00 +0000" },
                    { name: "Message-ID", value: "<gmsg-big@mail.gmail.com>" },
                  ],
                },
                internalDate: "1737025200000",
              }),
            })
          }
          throw new Error("Response body exceeds 1000000 bytes")
        }
        return JSON.stringify({ status: 200, headers: {}, body: "{}" })
      },
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      config_get: async () => null,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 15000,
    })

    // The added message ingested degraded (metadata + marker).
    const bigInsert = inserts.find(
      (insert) =>
        insert.entity === "messages" &&
        (insert.data.subject ?? insert.data.__sealedPlaintext?.subject ?? "") === "Big Incremental",
    )
    expect(bigInsert).toBeDefined()
    expect(bigInsert!.data.snippet ?? bigInsert!.data.__sealedPlaintext?.snippet).toContain(
      "attachment too large to sync",
    )
    expect(bigInsert!.data.textBody ?? bigInsert!.data.__sealedPlaintext?.textBody).toContain(
      "attachment too large to sync",
    )

    // lastSyncAt advanced -> tick completed, did not throw.
    expect(updates.some((update) => update.data.lastSyncAt)).toBe(true)
  })

  it("bounds a large backlog per run: checkpoints, hands off to a paced continuation, does not page the whole delta (OOM guard)", async () => {
    // A big post-outage gap: history page 1 carries > the 50/run budget of added
    // messages AND a nextPageToken. The run must process page 1, checkpoint
    // historyId, then RE-ENQUEUE a paced continuation and STOP -- never fetching
    // page 2 (paging the whole delta in one sandbox invocation is the OOM that
    // thrashed every mail call). It must NOT bump lastSyncAt, so the continuation
    // isn't skipped by the 60s-elapsed guard.
    const updates: any[] = []
    const jobs: any[] = []
    const historyPageTokens: (string | null)[] = []
    let insertSeq = 0
    const acc = {
      id: "acc-1",
      owner_type: "user",
      // Enrolled personal mailbox. Sync is suspended for a personal account
      // whose encryption_state is not "ready" (Task 4.4), so a sync fixture
      // must say which side of that line it is on.
      encryption_state: "ready",
      owner_id: "user-1",
      provider: "gmail",
      email_address: "test@gmail.com",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        if (entity !== "accounts") return JSON.stringify([])
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
        return JSON.stringify([acc])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: `gen-${++insertSeq}`, ...JSON.parse(dataJson) }),
      db_update: async (_e: string, id: string, dataJson: string) => {
        updates.push({ id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          const m = url.match(/[?&]pageToken=([^&]+)/)
          historyPageTokens.push(m ? decodeURIComponent(m[1]) : null)
          if (!m) {
            return JSON.stringify({
              status: 200,
              headers: {},
              body: JSON.stringify({
                nextPageToken: "page-2",
                history: Array.from({ length: 51 }, (_, i) => ({
                  id: String(1000 + i),
                  messagesAdded: [{ message: { id: `gm-${i}` } }],
                })),
              }),
            })
          }
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({ historyId: "999", history: [] }),
          })
        }
        if (url.includes("/messages/")) {
          const idm = url.match(/messages\/([^?]+)/)
          const id = idm ? idm[1] : "x"
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              id,
              threadId: `t-${id}`,
              labelIds: ["INBOX"],
              snippet: "s",
              payload: {
                headers: [
                  { name: "From", value: "a@b.com" },
                  { name: "Subject", value: "S" },
                  { name: "Date", value: "Mon, 15 Jan 2026 12:00:00 +0000" },
                  { name: "Message-ID", value: `<${id}@m>` },
                ],
              },
              internalDate: "1737025200000",
            }),
          })
        }
        return JSON.stringify({ status: 200, headers: {}, body: "{}" })
      },
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      config_get: async () => null,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 30000,
    })

    // Handed off: a paced continuation was enqueued for THIS account.
    expect(
      jobs.some(
        (j) =>
          j.name === "gmail-incremental-sync" &&
          String(j.opts?.jobId).startsWith("gmail-incremental-continue:acc-1:") &&
          j.opts?.delay > 0,
      ),
    ).toBe(true)
    // Stopped before page 2 -- only the first history page was ever fetched.
    expect(historyPageTokens).toEqual([null])
    // Did NOT finalize (no lastSyncAt bump), so the continuation isn't elapsed-guard
    // skipped; but the per-page historyId checkpoint DID advance past the start.
    expect(updates.some((u) => u.data.lastSyncAt)).toBe(false)
    expect(
      updates.some((u) => u.data.syncState?.historyId && u.data.syncState.historyId !== "123"),
    ).toBe(true)
  })

  it("budget gates BEFORE the fetch: message 51 of a single oversized history page is never fetched", async () => {
    // A single history page carries 51 messagesAdded entries (no nextPageToken --
    // the budget itself, not pagination, is what must stop the run at 50). The
    // 51st message must NEVER be fetched: the budget check happens before the
    // fetch, not after accumulating a full page.
    const updates: any[] = []
    const jobs: any[] = []
    const messageFetches: string[] = []
    let insertSeq = 0
    const acc = {
      id: "acc-1",
      owner_type: "user",
      // Enrolled personal mailbox. Sync is suspended for a personal account
      // whose encryption_state is not "ready" (Task 4.4), so a sync fixture
      // must say which side of that line it is on.
      encryption_state: "ready",
      owner_id: "user-1",
      provider: "gmail",
      email_address: "test@gmail.com",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        if (entity !== "accounts") return JSON.stringify([])
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
        return JSON.stringify([acc])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: `gen-${++insertSeq}`, ...JSON.parse(dataJson) }),
      db_update: async (_e: string, id: string, dataJson: string) => {
        updates.push({ id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              // Single page: no nextPageToken -- the budget itself must stop at 50.
              history: Array.from({ length: 51 }, (_, i) => ({
                id: String(1000 + i),
                messagesAdded: [{ message: { id: `gm-${i}` } }],
              })),
            }),
          })
        }
        if (url.includes("/messages/")) {
          messageFetches.push(url)
          const idm = url.match(/messages\/([^?]+)/)
          const id = idm ? idm[1] : "x"
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              id,
              threadId: `t-${id}`,
              labelIds: ["INBOX"],
              snippet: "s",
              payload: {
                headers: [
                  { name: "From", value: "a@b.com" },
                  { name: "Subject", value: "S" },
                  { name: "Date", value: "Mon, 15 Jan 2026 12:00:00 +0000" },
                  { name: "Message-ID", value: `<${id}@m>` },
                ],
              },
              internalDate: "1737025200000",
            }),
          })
        }
        return JSON.stringify({ status: 200, headers: {}, body: "{}" })
      },
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      config_get: async () => null,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 30000,
    })

    // Exactly 50 message fetches -- message 51 was never fetched.
    expect(messageFetches.length).toBe(50)
    // Continuation was enqueued.
    expect(
      jobs.some(
        (j) =>
          j.name === "gmail-incremental-sync" &&
          String(j.opts?.jobId).startsWith("gmail-incremental-continue:acc-1:"),
      ),
    ).toBe(true)
    // lastSyncAt was NOT bumped.
    expect(updates.some((u) => u.data.lastSyncAt)).toBe(false)
  })

  it("skipped (404) messages spend the run budget too, so a replay over deleted mail hands off instead of timing out", async () => {
    // Prod 2026-09-13: a two-day replay met 80+ consecutive 404s (spam purged
    // since). Only stored messages counted toward the 50/run budget, so the run
    // fetched them all, never handed off, and died on the sandbox execution
    // timeout with no continuation scheduled. Every fetch is a round trip and
    // must count: 51 deleted messages on one page -> 50 fetches, hand-off.
    const updates: any[] = []
    const jobs: any[] = []
    const messageFetches: string[] = []
    const acc = {
      id: "acc-1",
      owner_type: "user",
      encryption_state: "ready",
      owner_id: "user-1",
      provider: "gmail",
      email_address: "test@gmail.com",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        if (entity !== "accounts") return JSON.stringify([])
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
        return JSON.stringify([acc])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: "gen-1", ...JSON.parse(dataJson) }),
      db_update: async (_e: string, id: string, dataJson: string) => {
        updates.push({ id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              history: Array.from({ length: 51 }, (_, i) => ({
                id: String(1000 + i),
                messagesAdded: [{ message: { id: `gm-${i}` } }],
              })),
            }),
          })
        }
        if (url.includes("/messages/")) {
          messageFetches.push(url)
          // Deleted since the history record was written.
          return JSON.stringify({ status: 404, headers: {}, body: "{}" })
        }
        return JSON.stringify({ status: 200, headers: {}, body: "{}" })
      },
      hasOnlineUsers: async () => JSON.stringify(true),
      config_get: async () => null,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 30000,
    })

    // Exactly 50 round trips, then a paced continuation, and no finalize.
    expect(messageFetches.length).toBe(50)
    expect(
      jobs.some(
        (j) =>
          j.name === "gmail-incremental-sync" &&
          String(j.opts?.jobId).startsWith("gmail-incremental-continue:acc-1:"),
      ),
    ).toBe(true)
    expect(updates.some((u) => u.data.lastSyncAt)).toBe(false)
  })

  it("a run cut by the sandbox deadline after making progress schedules its own paced continuation", async () => {
    // Prod 2026-09-13: a replay continuation stored 50 sealed messages, then the
    // execution deadline fired ("InternalError: interrupted") inside the page
    // loop. The catch logged and returned: no hand-off, no continuation, and the
    // rest of the backlog waited for the next push or online tick. The error is
    // simulated by a bridge fetch that throws the interrupt message after a few
    // stored messages; the real deadline unwinds through the same catch.
    const updates: any[] = []
    const jobs: any[] = []
    let fetches = 0
    const acc = {
      id: "acc-1",
      owner_type: "user",
      encryption_state: "ready",
      owner_id: "user-1",
      provider: "gmail",
      email_address: "test@gmail.com",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        if (entity !== "accounts") return JSON.stringify([])
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
        return JSON.stringify([acc])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: `gen-${Math.random()}`, ...JSON.parse(dataJson) }),
      db_update: async (_e: string, id: string, dataJson: string) => {
        updates.push({ id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              history: Array.from({ length: 20 }, (_, i) => ({
                id: String(1000 + i),
                messagesAdded: [{ message: { id: `gm-${i}` } }],
              })),
            }),
          })
        }
        if (url.includes("/messages/")) {
          fetches++
          if (fetches > 3) throw new Error("InternalError: interrupted")
          const idm = url.match(/messages\/([^?]+)/)
          const id = idm ? idm[1] : "x"
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              id,
              threadId: `t-${id}`,
              labelIds: ["INBOX"],
              snippet: "s",
              payload: {
                headers: [
                  { name: "From", value: "a@b.com" },
                  { name: "Subject", value: "S" },
                  { name: "Date", value: "Mon, 15 Jan 2026 12:00:00 +0000" },
                  { name: "Message-ID", value: `<${id}@m>` },
                ],
              },
              internalDate: "1737025200000",
            }),
          })
        }
        return JSON.stringify({ status: 200, headers: {}, body: "{}" })
      },
      hasOnlineUsers: async () => JSON.stringify(true),
      config_get: async () => null,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 30000,
    })

    // Three messages landed before the cut, so the run progressed and must
    // schedule the paced continuation; it must not finalize.
    expect(
      jobs.some(
        (j) =>
          j.name === "gmail-incremental-sync" &&
          String(j.opts?.jobId).startsWith("gmail-incremental-continue:acc-1:") &&
          j.opts?.delay > 0,
      ),
    ).toBe(true)
    expect(updates.some((u) => u.data.lastSyncAt)).toBe(false)
  })

  it("a run cut by the sandbox deadline with no progress does not loop on itself", async () => {
    // Same cut, but on the very first fetch: nothing stored, cursor unmoved. A
    // continuation here would re-run every few seconds forever.
    const jobs: any[] = []
    const acc = {
      id: "acc-1",
      owner_type: "user",
      encryption_state: "ready",
      owner_id: "user-1",
      provider: "gmail",
      email_address: "test@gmail.com",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        if (entity !== "accounts") return JSON.stringify([])
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
        return JSON.stringify([acc])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: "gen-1", ...JSON.parse(dataJson) }),
      db_update: async () => {},
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              history: [{ id: "1000", messagesAdded: [{ message: { id: "gm-0" } }] }],
            }),
          })
        }
        throw new Error("InternalError: interrupted")
      },
      hasOnlineUsers: async () => JSON.stringify(true),
      config_get: async () => null,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 30000,
    })

    expect(
      jobs.some((j) => String(j.opts?.jobId).startsWith("gmail-incremental-continue:acc-1:")),
    ).toBe(false)
  })

  it("consecutive continuation hops never share a jobId, so a chain can outlive its active predecessor", async () => {
    // Prod 2026-09-13: the continuation enqueued its successor under its own
    // fixed id while it was still the active BullMQ job; the add was silently
    // ignored and every replay stalled after exactly one hop, with no error.
    // Two hand-off runs back to back must therefore hand off under two ids.
    const jobIds: string[] = []
    const acc = {
      id: "acc-1",
      owner_type: "user",
      encryption_state: "ready",
      owner_id: "user-1",
      provider: "gmail",
      email_address: "test@gmail.com",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        if (entity !== "accounts") return JSON.stringify([])
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
        return JSON.stringify([acc])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: `gen-${Math.random()}`, ...JSON.parse(dataJson) }),
      db_update: async () => {},
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, _payload: string, opts?: string) => {
        if (name === "gmail-incremental-sync" && opts) jobIds.push(JSON.parse(opts).jobId)
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              history: Array.from({ length: 51 }, (_, i) => ({
                id: String(1000 + i),
                messagesAdded: [{ message: { id: `gm-${i}` } }],
              })),
            }),
          })
        }
        // Deleted since: cheap round trips that still spend the budget.
        return JSON.stringify({ status: 404, headers: {}, body: "{}" })
      },
      hasOnlineUsers: async () => JSON.stringify(true),
      config_get: async () => null,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    for (let hop = 0; hop < 2; hop++) {
      await executeInSandbox({
        pool: getSandboxPool(),
        bundleSource,
        exportName: "gmailIncrementalSync",
        params: { orgId: "org-1", accountId: "acc-1" },
        bridge,
        timeoutMs: 30000,
      })
      // Ensure the two hops cannot land on the same clock tick.
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(jobIds.length).toBe(2)
    for (const id of jobIds) expect(id.startsWith("gmail-incremental-continue:acc-1:")).toBe(true)
    expect(jobIds[0]).not.toBe(jobIds[1])
  })

  it("a progressed run that hits the Gmail rate limit continues itself a minute later", async () => {
    // Prod 2026-09-13: a backlog replay chained three hops in fifty seconds and
    // then history.list answered 403 "Quota exceeded" (per-user rate limit).
    // The run logged and ended; the quota refills within a minute, so the
    // chain must reschedule itself, paced back to a minute, not wait for the
    // next external trigger.
    const updates: any[] = []
    const jobs: any[] = []
    let historyCalls = 0
    const acc = {
      id: "acc-1",
      owner_type: "user",
      encryption_state: "ready",
      owner_id: "user-1",
      provider: "gmail",
      email_address: "test@gmail.com",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        if (entity !== "accounts") return JSON.stringify([])
        const where = JSON.parse(optsJson)?.where ?? {}
        if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
        return JSON.stringify([acc])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: `gen-${Math.random()}`, ...JSON.parse(dataJson) }),
      db_update: async (_e: string, id: string, dataJson: string) => {
        updates.push({ id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          historyCalls++
          if (historyCalls === 1) {
            return JSON.stringify({
              status: 200,
              headers: {},
              body: JSON.stringify({
                nextPageToken: "page-2",
                history: [
                  { id: "1000", messagesAdded: [{ message: { id: "gm-0" } }] },
                  { id: "1001", messagesAdded: [{ message: { id: "gm-1" } }] },
                ],
              }),
            })
          }
          return JSON.stringify({
            status: 403,
            headers: {},
            body: JSON.stringify({
              error: {
                code: 403,
                message:
                  "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'",
                errors: [{ reason: "rateLimitExceeded", domain: "usageLimits" }],
              },
            }),
          })
        }
        if (url.includes("/messages/")) {
          const idm = url.match(/messages\/([^?]+)/)
          const id = idm ? idm[1] : "x"
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              id,
              threadId: `t-${id}`,
              labelIds: ["INBOX"],
              snippet: "s",
              payload: {
                headers: [
                  { name: "From", value: "a@b.com" },
                  { name: "Subject", value: "S" },
                  { name: "Date", value: "Mon, 15 Jan 2026 12:00:00 +0000" },
                  { name: "Message-ID", value: `<${id}@m>` },
                ],
              },
              internalDate: "1737025200000",
            }),
          })
        }
        return JSON.stringify({ status: 200, headers: {}, body: "{}" })
      },
      hasOnlineUsers: async () => JSON.stringify(true),
      config_get: async () => null,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 30000,
    })

    // Page 1 landed and was checkpointed, page 2 hit the limit: continuation
    // scheduled with a delay of at least a minute, no finalize.
    const cont = jobs.find(
      (j) =>
        j.name === "gmail-incremental-sync" &&
        String(j.opts?.jobId).startsWith("gmail-incremental-continue:acc-1:"),
    )
    expect(cont).toBeDefined()
    expect(cont.opts.delay).toBeGreaterThanOrEqual(60_000)
    expect(updates.some((u) => u.data.syncState?.historyId === "1001")).toBe(true)
    expect(updates.some((u) => u.data.lastSyncAt)).toBe(false)
  })

  it("already-stored messages are skipped without a fetch, so a replay makes progress", async () => {
    // A history page lists 3 messagesAdded; the first 2 are already stored
    // (a replay from an old checkpoint) and must be skipped WITHOUT a Gmail
    // fetch. Only the 3rd (genuinely new) message is fetched + ingested, and
    // the run stays far under budget (no handoff).
    const updates: any[] = []
    const jobs: any[] = []
    const inserts: any[] = []
    const messageFetches: string[] = []
    const acc = {
      id: "acc-1",
      owner_type: "user",
      // Enrolled personal mailbox. Sync is suspended for a personal account
      // whose encryption_state is not "ready" (Task 4.4), so a sync fixture
      // must say which side of that line it is on.
      encryption_state: "ready",
      owner_id: "user-1",
      provider: "gmail",
      email_address: "test@gmail.com",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        if (entity === "accounts") {
          const where = JSON.parse(optsJson)?.where ?? {}
          if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
          return JSON.stringify([acc])
        }
        if (entity === "messages") {
          const where = JSON.parse(optsJson)?.where ?? {}
          const externalProviderId = where.externalProviderId
          if (externalProviderId === "gm-0" || externalProviderId === "gm-1") {
            return JSON.stringify([{ id: "already-stored" }])
          }
          return JSON.stringify([])
        }
        return JSON.stringify([])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (entity: string, dataJson: string) => {
        const data = JSON.parse(dataJson)
        inserts.push({ entity, data })
        return JSON.stringify({ id: `gen-${inserts.length}`, ...data })
      },
      db_update: async (_e: string, id: string, dataJson: string) => {
        updates.push({ id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              history: [
                {
                  id: "1000",
                  messagesAdded: [
                    { message: { id: "gm-0" } },
                    { message: { id: "gm-1" } },
                    { message: { id: "gm-2" } },
                  ],
                },
              ],
            }),
          })
        }
        if (url.includes("/messages/")) {
          messageFetches.push(url)
          const idm = url.match(/messages\/([^?]+)/)
          const id = idm ? idm[1] : "x"
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              id,
              threadId: `t-${id}`,
              labelIds: ["INBOX"],
              snippet: "s",
              payload: {
                headers: [
                  { name: "From", value: "a@b.com" },
                  { name: "Subject", value: "New Message" },
                  { name: "Date", value: "Mon, 15 Jan 2026 12:00:00 +0000" },
                  { name: "Message-ID", value: `<${id}@m>` },
                ],
              },
              internalDate: "1737025200000",
            }),
          })
        }
        return JSON.stringify({ status: 200, headers: {}, body: "{}" })
      },
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      hasOnlineUsers: async () => JSON.stringify(true),
      config_get: async () => null,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 30000,
    })

    // Only 1 fetch -- for the 3rd (not-yet-stored) message.
    expect(messageFetches.length).toBe(1)
    expect(messageFetches[0]).toContain("gm-2")

    // Only the 3rd message was written.
    const messageInserts = inserts.filter((insert) => insert.entity === "messages")
    expect(messageInserts.length).toBe(1)
    expect(
      messageInserts[0].data.subject ?? messageInserts[0].data.__sealedPlaintext?.subject,
    ).toBe("New Message")

    // No handoff -- far under budget.
    expect(
      jobs.some(
        (j) =>
          j.name === "gmail-incremental-sync" &&
          String(j.opts?.jobId).startsWith("gmail-incremental-continue:acc-1:"),
      ),
    ).toBe(false)
  })

  it("a label change on a long, heavy thread rolls the conversation up without loading message bodies (sandbox heap guard)", async () => {
    // Prod 2026-09-11: one mailbox stopped syncing for two days. Every tick
    // died with "InternalError: out of memory" and the history cursor never
    // advanced. The record was an ordinary labelRemoved UNREAD on a 70-message
    // thread; recomputeConversationState read the thread with SELECT * and the
    // bodies (plus base64 ciphertext) exceeded the 32 MB QuickJS heap. The
    // roll-up needs labels/flags/ordering and the latest message's pointers,
    // never a body. The mock returns the heavy rows unless the read projects
    // its columns, so this test goes red on a SELECT * regression by OOMing
    // in the real sandbox, not by inspecting the call.
    const updates: any[] = []
    const conversationReads: any[] = []
    const acc = {
      id: "acc-1",
      owner_type: "user",
      encryption_state: "ready",
      owner_id: "user-1",
      provider: "gmail",
      email_address: "test@gmail.com",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const heavyBody = "x".repeat(400_000)
    const threadRows = Array.from({ length: 70 }, (_, i) => ({
      id: `m-${i}`,
      conversation_id: "conv-1",
      account_id: "acc-1",
      external_provider_id: `gm-${i}`,
      labels: ["INBOX"],
      is_read: true,
      is_starred: false,
      sent_at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      snippet: null,
      enc_version: 1,
      text_body: null,
      html_body: null,
      subject: null,
      // Sealed rows carry their bodies as bytea, which the bridge base64s.
      text_body_ciphertext: heavyBody,
      html_body_ciphertext: heavyBody,
      subject_ciphertext: "c3Vi",
      snippet_ciphertext: "c25pcA==",
      raw_headers_ciphertext: null,
      content_key_wrapped: "d3JhcHBlZA==",
      content_key_epk: "ZXBr",
      enc_key_id: 1,
    }))
    const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
    const loggedErrors: string[] = []
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      hasOnlineUsers: async () => "true",
      log_info: async () => {},
      log_warn: async () => {},
      log_error: async (msg: string, dataJson?: string) => {
        loggedErrors.push(`${msg} ${dataJson ?? ""}`)
      },
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        const opts = JSON.parse(optsJson) ?? {}
        const where = opts.where ?? {}
        if (entity === "accounts") {
          if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
          return JSON.stringify([acc])
        }
        if (entity !== "messages") return JSON.stringify([])
        if (where.externalProviderId === "gm-big") {
          return JSON.stringify([
            { id: "m-big", conversation_id: "conv-1", labels: ["INBOX", "UNREAD"] },
          ])
        }
        if (where.conversationId === "conv-1") {
          conversationReads.push(opts)
          const ordered =
            opts.orderBy?.sentAt === "desc"
              ? [...threadRows].sort((a, b) => b.sent_at.localeCompare(a.sent_at))
              : threadRows
          if (!Array.isArray(opts.select)) return JSON.stringify(ordered)
          const cols = new Set(opts.select.map(snake))
          return JSON.stringify(
            ordered.map((row) =>
              Object.fromEntries(Object.entries(row).filter(([k]) => cols.has(k))),
            ),
          )
        }
        return JSON.stringify([])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: "gen-1", ...JSON.parse(dataJson) }),
      db_update: async (entity: string, id: string, dataJson: string) => {
        updates.push({ entity, id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async () => {},
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              historyId: "2001",
              history: [
                {
                  id: "2000",
                  labelsRemoved: [{ message: { id: "gm-big" }, labelIds: ["UNREAD"] }],
                },
              ],
            }),
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      },
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 30000,
    })

    // The handler swallows the failure into a log line; surface it as the
    // assertion message so a regression reads "out of memory", not "undefined".
    expect(loggedErrors).toEqual([])
    // The message itself lost UNREAD.
    const messageUpdate = updates.find((u) => u.entity === "messages" && u.id === "m-big")
    expect(messageUpdate?.data.isRead).toBe(true)
    expect(messageUpdate?.data.labels).toEqual(["INBOX"])
    // The thread roll-up ran over all 70 messages and finished: read, open,
    // latest message's sealed pointers copied.
    const convUpdate = updates.find((u) => u.entity === "conversations" && u.id === "conv-1")
    expect(convUpdate?.data.isRead).toBe(true)
    expect(convUpdate?.data.status).toBe("open")
    expect(convUpdate?.data.snippetSourceMessageId).toBe("m-69")
    // The read projected its columns and none of them is a body.
    expect(conversationReads.length).toBe(1)
    const selected: string[] = conversationReads[0].select
    expect(Array.isArray(selected)).toBe(true)
    for (const body of ["textBody", "htmlBody", "textBodyCiphertext", "htmlBodyCiphertext"]) {
      expect(selected).not.toContain(body)
    }
    // The run did not die: lastSyncAt advanced with the new cursor.
    const finalized = updates.find((u) => u.entity === "accounts" && u.data.lastSyncAt)
    expect(finalized?.data.syncState?.historyId).toBe("2001")
  })

  it("scheduled tick rescues accounts stranded in pre-sync or syncing", async () => {
    // A connect-time initial-sync job that gets lost (deploy restart, crash)
    // used to strand the account forever: the scheduled sync only reads
    // syncStatus='active' accounts, so nothing ever retried (prod
    // pat@fabrikam.example sat in pre-sync for a day with no error). The tick
    // must re-enqueue the initial sync (fixed jobId; resumes from
    // syncState.cursor) regardless of online users.
    const jobs: any[] = []
    const accountsByStatus: Record<string, any[]> = {
      "pre-sync": [
        {
          id: "acc-stranded",
          provider: "gmail",
          email_address: "stranded@gmail.com",
          sync_status: "pre-sync",
          sync_state: null,
          disconnected_at: null,
        },
        // A personal mailbox that cannot sync until its owner acts is NOT
        // stranded: re-enqueueing it polled it every five minutes forever, each
        // run logging "suspended" and exiting (prod 2026-09-30, design audit
        // #13). The owner is told by an attention item instead.
        ...["pending_enrollment", "blocked", "paused"].map((state) => ({
          id: `acc-${state}`,
          provider: "gmail",
          owner_type: "user",
          owner_id: "user-1",
          encryption_state: state,
          email_address: `${state}@gmail.com`,
          sync_status: "pre-sync",
          sync_state: null,
          disconnected_at: null,
        })),
      ],
      syncing: [
        {
          id: "acc-crashed",
          provider: "gmail",
          email_address: "crashed@gmail.com",
          sync_status: "syncing",
          sync_state: { cursor: "page-3" },
          disconnected_at: null,
          // Stale row: the page chain stopped saving progress long ago.
          updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
        },
        {
          id: "acc-gone",
          provider: "gmail",
          email_address: "gone@gmail.com",
          sync_status: "syncing",
          sync_state: null,
          disconnected_at: "2026-01-01T00:00:00Z",
        },
        {
          // A LIVE backfill (fresh updated_at: its page jobs save cursor progress
          // every few seconds) must NOT be rescued -- the chain's page jobs carry
          // no custom jobId, so a rescue add would run a SECOND initial sync
          // concurrently and the two would fight over the accounts row lock.
          id: "acc-live",
          provider: "gmail",
          email_address: "live@gmail.com",
          sync_status: "syncing",
          sync_state: { cursor: "page-9" },
          disconnected_at: null,
          updated_at: new Date().toISOString(),
        },
      ],
      active: [],
    }
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      db_findOne: async () => JSON.stringify(null),
      db_findMany: async (_entity: string, optsJson: string) => {
        const where = JSON.parse(optsJson)?.where ?? {}
        return JSON.stringify(accountsByStatus[where.syncStatus] ?? [])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async () => JSON.stringify({ id: "x" }),
      db_update: async () => {},
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => JSON.stringify({ id: "c1" }),
      fetch: async () => JSON.stringify({ status: 200, headers: {}, body: "{}" }),
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<x>" }),
      // Nobody online: the rescue must fire anyway.
      hasOnlineUsers: async () => JSON.stringify(false),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1" },
      bridge,
    })

    expect(jobs).toEqual([
      expect.objectContaining({
        name: "gmail-initial-sync",
        payload: { orgId: "org-1", accountId: "acc-stranded" },
        opts: { jobId: "gmail-initial-sync:acc-stranded" },
      }),
      expect.objectContaining({
        name: "gmail-initial-sync",
        payload: { orgId: "org-1", accountId: "acc-crashed" },
        opts: { jobId: "gmail-initial-sync:acc-crashed" },
      }),
    ])
  })
})

describe("conversation roll-up on a freshly enrolled mailbox", () => {
  let bundleSource: string

  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  })

  it("a label change on a thread whose latest message predates enrollment never writes the plaintext snippet back", async () => {
    // Prod 2026-09-14: the owner finished the encryption setup the banner asked
    // for, and the very next incremental tick died with
    // "mailbox_plaintext_forbidden: cannot write plaintext snippet on
    // conversations". The thread's messages were ingested before enrollment,
    // so the latest one carries no ciphertext, and the roll-up wrote its
    // plaintext snippet back into a table the owner's new identity had just
    // armed. Every tick that touched an old thread failed the same way for the
    // twenty-four minutes it took the hourly backfill to seal the corpus. For
    // a sealing mailbox the roll-up leaves the snippet alone.
    const updates: any[] = []
    const acc = {
      id: "acc-1",
      owner_type: "user",
      encryption_state: "ready",
      owner_id: "user-1",
      provider: "gmail",
      email_address: "test@gmail.com",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const oldRows = [
      {
        id: "m-old",
        conversation_id: "conv-1",
        account_id: "acc-1",
        external_provider_id: "gm-old",
        // The mock does not apply the message update, so the roll-up reads
        // the row as it will be after UNREAD is dropped.
        labels: ["INBOX"],
        is_read: true,
        is_starred: false,
        sent_at: "2026-08-01T10:00:00.000Z",
        snippet: "plaintext from before enrollment",
        enc_version: 0,
      },
    ]
    const loggedErrors: string[] = []
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      hasOnlineUsers: async () => "true",
      log_info: async () => {},
      log_warn: async () => {},
      log_error: async (msg: string, dataJson?: string) => {
        loggedErrors.push(`${msg} ${dataJson ?? ""}`)
      },
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        const where = JSON.parse(optsJson)?.where ?? {}
        if (entity === "accounts") {
          if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
          return JSON.stringify([acc])
        }
        if (entity !== "messages") return JSON.stringify([])
        if (where.externalProviderId === "gm-old" || where.conversationId === "conv-1") {
          return JSON.stringify(oldRows)
        }
        return JSON.stringify([])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: "gen-1", ...JSON.parse(dataJson) }),
      db_update: async (entity: string, id: string, dataJson: string) => {
        updates.push({ entity, id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async () => {},
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              historyId: "2001",
              history: [
                {
                  id: "2000",
                  labelsRemoved: [{ message: { id: "gm-old" }, labelIds: ["UNREAD"] }],
                },
              ],
            }),
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      },
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-1" },
      bridge,
      timeoutMs: 30000,
    })

    expect(loggedErrors).toEqual([])
    const convUpdate = updates.find((u) => u.entity === "conversations" && u.id === "conv-1")
    expect(convUpdate?.data.isRead).toBe(true)
    // The load-bearing assertion: no plaintext content column in the write.
    expect(convUpdate?.data).not.toHaveProperty("snippet")
    expect(convUpdate?.data).not.toHaveProperty("subject")
    const finalized = updates.find((u) => u.entity === "accounts" && u.data.lastSyncAt)
    expect(finalized?.data.syncState?.historyId).toBe("2001")
  })

  it("an unencrypted (shared) mailbox still rolls the plaintext snippet up", async () => {
    // The guard above is keyed on the mailbox, not on the message: an org
    // mailbox is outside the regime and its conversation preview must keep
    // following the latest message.
    const updates: any[] = []
    const acc = {
      id: "acc-org",
      owner_type: "org",
      encryption_state: "none",
      owner_id: null,
      provider: "gmail",
      email_address: "support@acme.test",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const rows = [
      {
        id: "m-1",
        conversation_id: "conv-1",
        account_id: "acc-org",
        external_provider_id: "gm-1",
        labels: ["INBOX"],
        is_read: true,
        is_starred: false,
        sent_at: "2026-08-01T10:00:00.000Z",
        snippet: "shared preview",
        enc_version: 0,
      },
    ]
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      hasOnlineUsers: async () => "true",
      log_info: async () => {},
      log_warn: async () => {},
      log_error: async () => {},
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        const where = JSON.parse(optsJson)?.where ?? {}
        if (entity === "accounts") {
          if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
          return JSON.stringify([acc])
        }
        if (entity !== "messages") return JSON.stringify([])
        if (where.externalProviderId === "gm-1" || where.conversationId === "conv-1") {
          return JSON.stringify(rows)
        }
        return JSON.stringify([])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: "gen-1", ...JSON.parse(dataJson) }),
      db_update: async (entity: string, id: string, dataJson: string) => {
        updates.push({ entity, id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async () => {},
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              historyId: "2001",
              history: [
                { id: "2000", labelsRemoved: [{ message: { id: "gm-1" }, labelIds: ["UNREAD"] }] },
              ],
            }),
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      },
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-org" },
      bridge,
      timeoutMs: 30000,
    })

    const convUpdate = updates.find((u) => u.entity === "conversations" && u.id === "conv-1")
    expect(convUpdate?.data.snippet).toBe("shared preview")
  })
})

describe("onAccountConnected: reconnecting an existing mailbox", () => {
  let bundleSource: string

  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  })

  function connectEvent(
    connectionName: "gmail" | "imap" = "gmail",
    owner: { ownerType: "user" | "org"; ownerId: string | null } = {
      ownerType: "user",
      ownerId: "user-1",
    },
  ) {
    return {
      orgId: "org-1",
      data: {
        appName: "mail",
        id: "conn-new",
        ...owner,
        identifier: "test@gmail.com",
        connectionName,
      },
    }
  }

  async function reconnect(
    existingRow: Record<string, unknown> | null,
    event = connectEvent(),
    release: Record<string, unknown> = { outcome: "released", conversations: 0, messages: 0 },
  ) {
    const updates: any[] = []
    const inserts: any[] = []
    const jobs: any[] = []
    const deletes: Array<{ entity: string; id: string }> = []
    const disconnects: Array<{ id: string; notice: any }> = []
    const releases: any[] = []
    const bridge: Record<string, any> = {
      mail_releaseForeignAccount: async (paramsJson: string) => {
        releases.push(JSON.parse(paramsJson))
        return JSON.stringify(release)
      },
      getUserId: () => "system",
      getOrgId: () => "org-1",
      log_info: async () => {},
      log_warn: async () => {},
      log_error: async () => {},
      db_findOne: async () => JSON.stringify(null),
      db_findMany: async (entity: string) =>
        JSON.stringify(entity === "accounts" && existingRow ? [existingRow] : []),
      db_insert: async (entity: string, dataJson: string) => {
        const data = JSON.parse(dataJson)
        inserts.push({ entity, data })
        return JSON.stringify({ id: "gen-1", ...data })
      },
      db_update: async (entity: string, id: string, dataJson: string) => {
        updates.push({ entity, id, data: JSON.parse(dataJson) })
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async (entity: string, id: string) => {
        deletes.push({ entity, id })
      },
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async (connectionId: string, noticeJson?: string) => {
        disconnects.push({ id: connectionId, notice: noticeJson ? JSON.parse(noticeJson) : null })
      },
      hasScope: async () => true,
    }
    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "onAccountConnected",
      params: event,
      bridge,
      timeoutMs: 15000,
    })
    return { updates, inserts, jobs, deletes, disconnects, releases }
  }

  const base = {
    id: "acc-1",
    owner_type: "user",
    owner_id: "user-1",
    provider: "gmail",
    email_address: "test@gmail.com",
    disconnected_at: "2026-09-14T12:56:08.000Z",
    connected_account_id: "conn-old",
  }

  it("a mailbox that completed an import resumes as active with one incremental tick, not a full re-import", async () => {
    // Prod 2026-09-14: a re-authorization reset a fully imported mailbox to
    // pre-sync, and the connect-time initial sync re-fetched all ten thousand
    // messages while the mailbox reported "syncing". The history cursor was
    // there the whole time.
    const { updates, jobs } = await reconnect({
      ...base,
      sync_status: "active",
      sync_state: { historyId: "2774546", messagesSynced: 9931 },
    })
    const rebind = updates.find((u) => u.entity === "accounts" && u.id === "acc-1")
    expect(rebind?.data.connectedAccountId).toBe("conn-new")
    expect(rebind?.data.syncStatus).toBe("active")
    expect(rebind?.data.disconnectedAt).toBeNull()
    expect(jobs.map((j) => j.name)).toEqual(["gmail-incremental-sync"])
    expect(jobs[0].payload).toEqual({ orgId: "org-1", accountId: "acc-1" })
    expect(jobs[0].opts?.jobId).toBe("gmail-incremental-sync:acc-1")
  })

  it("a mailbox mid-backfill keeps its page chain and gets no second one", async () => {
    const { updates, jobs } = await reconnect({
      ...base,
      sync_status: "syncing",
      sync_state: { historyId: "1", cursor: "page-7", messagesSynced: 700 },
    })
    const rebind = updates.find((u) => u.entity === "accounts" && u.id === "acc-1")
    expect(rebind?.data.syncStatus).toBe("syncing")
    expect(jobs).toEqual([])
  })

  it("a mailbox that never finished importing starts over", async () => {
    const { updates, jobs } = await reconnect({
      ...base,
      sync_status: "pre-sync",
      sync_state: null,
    })
    const rebind = updates.find((u) => u.entity === "accounts" && u.id === "acc-1")
    expect(rebind?.data.syncStatus).toBe("pre-sync")
    expect(jobs.map((j) => j.name)).toEqual(["gmail-initial-sync"])
  })

  it("an IMAP mailbox resumes on its uidValidity", async () => {
    const { updates, jobs } = await reconnect(
      { ...base, provider: "imap", sync_status: "active", sync_state: { uidValidity: 42 } },
      connectEvent("imap"),
    )
    const rebind = updates.find((u) => u.entity === "accounts" && u.id === "acc-1")
    expect(rebind?.data.syncStatus).toBe("active")
    expect(jobs.map((j) => j.name)).toEqual(["imap-incremental-sync"])
  })

  it("a brand-new mailbox is inserted at pre-sync and imported", async () => {
    const { inserts, jobs } = await reconnect(null)
    expect(inserts.find((i) => i.entity === "accounts")?.data.syncStatus).toBe("pre-sync")
    expect(jobs.map((j) => j.name)).toEqual(["gmail-initial-sync"])
  })

  // A mailbox row belongs to its owner. A personal connect of an address the
  // organization once connected used to rebind the org's shared row: the member's
  // own mail landed in an org-owned mailbox that mail admins see, unencrypted.
  const orgRow = { ...base, owner_type: "org", owner_id: null }

  it("a personal connect never rebinds the org's row: the host releases it, a personal row is created", async () => {
    const { updates, inserts, releases, disconnects } = await reconnect({
      ...orgRow,
      sync_status: "disconnected",
      sync_state: null,
    })
    expect(updates.filter((u) => u.entity === "accounts")).toEqual([])
    expect(releases).toEqual([{ accountId: "acc-1", connectionId: "conn-new" }])
    const created = inserts.find((i) => i.entity === "accounts")?.data
    expect(created?.ownerType).toBe("user")
    expect(created?.ownerId).toBe("user-1")
    expect(created?.connectedAccountId).toBe("conn-new")
    expect(disconnects).toEqual([])
  })

  it("an org connect (a takeover) never rebinds a member's personal row, whatever its sync status", async () => {
    const { updates, inserts, releases } = await reconnect(
      { ...base, sync_status: "active", sync_state: { historyId: "9" } },
      connectEvent("gmail", { ownerType: "org", ownerId: null }),
    )
    expect(updates.filter((u) => u.entity === "accounts")).toEqual([])
    expect(releases).toEqual([{ accountId: "acc-1", connectionId: "conn-new" }])
    const created = inserts.find((i) => i.entity === "accounts")?.data
    expect(created?.ownerType).toBe("org")
    expect(created?.ownerId).toBeUndefined()
  })

  it("an address another owner's mailbox still holds is refused, and the person is told", async () => {
    const { updates, inserts, jobs, disconnects } = await reconnect(
      { ...orgRow, provider: "imap", sync_status: "active", sync_state: { uidValidity: 4 } },
      connectEvent("gmail"),
      { outcome: "held", heldBy: "org" },
    )
    expect(updates).toEqual([])
    expect(inserts).toEqual([])
    expect(jobs).toEqual([])
    expect(disconnects).toHaveLength(1)
    expect(disconnects[0].id).toBe("conn-new")
    expect(disconnects[0].notice.reason).toBe("connect_refused")
    expect(disconnects[0].notice.summary).toContain("the organization's mailbox")
  })

  it("a connect that did not prove control (IMAP login refused) leaves the other row and says why", async () => {
    const { inserts, disconnects } = await reconnect(
      { ...orgRow, sync_status: "disconnected", sync_state: null },
      connectEvent("imap"),
      { outcome: "unproven" },
    )
    expect(inserts).toEqual([])
    expect(disconnects[0].notice.summary).toContain("refused the login")
  })
})

// READ IN GMAIL MEANS READ IN LIAISON. Opening a thread in Gmail reads every
// message in it, and Gmail reports that as ONE history record carrying one
// `labelsRemoved` entry per message. The sync applied only the first entry's
// message, so the rest of the thread stayed UNREAD here and the conversation
// kept its unread dot (prod: 44 conversations whose latest message was read
// while an older one was not, which a thread read in Gmail never leaves).
describe("Gmail read state reaches Liaison (inbound UNREAD sync)", () => {
  let bundleSource: string

  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  })

  it("a thread read in Gmail (one record, several messages) is read here, message by message, and live", async () => {
    const updates: any[] = []
    const emitted: any[] = []
    const acc = {
      id: "acc-org",
      owner_type: "org",
      encryption_state: "none",
      owner_id: null,
      provider: "gmail",
      email_address: "support@acme.test",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const rows: Record<string, any> = {
      "gm-1": {
        id: "m-1",
        conversation_id: "conv-1",
        account_id: "acc-org",
        labels: ["INBOX", "UNREAD"],
        is_read: false,
        is_starred: false,
        sent_at: "2026-09-01T10:00:00.000Z",
        snippet: "first",
        enc_version: 0,
      },
      "gm-2": {
        id: "m-2",
        conversation_id: "conv-1",
        account_id: "acc-org",
        labels: ["INBOX", "UNREAD"],
        is_read: false,
        is_starred: false,
        sent_at: "2026-09-01T11:00:00.000Z",
        snippet: "second",
        enc_version: 0,
      },
    }
    const byId = (id: string) => Object.values(rows).find((r) => r.id === id)
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      hasOnlineUsers: async () => "true",
      log_info: async () => {},
      log_warn: async () => {},
      log_error: async () => {},
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string, optsJson: string) => {
        const where = JSON.parse(optsJson)?.where ?? {}
        if (entity === "accounts") {
          if (where.syncStatus && where.syncStatus !== "active") return JSON.stringify([])
          return JSON.stringify([acc])
        }
        if (entity !== "messages") return JSON.stringify([])
        if (where.externalProviderId) {
          const row = rows[where.externalProviderId]
          return JSON.stringify(row ? [row] : [])
        }
        if (where.conversationId === "conv-1") {
          return JSON.stringify(
            Object.values(rows).sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1)),
          )
        }
        return JSON.stringify([])
      },
      mailbox_sealAndInsert: async (paramsJson: string) => stubSealAndInsert(bridge, paramsJson),
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: "gen-1", ...JSON.parse(dataJson) }),
      db_update: async (entity: string, id: string, dataJson: string) => {
        const data = JSON.parse(dataJson)
        updates.push({ entity, id, data })
        // The store follows the writes, as the database would.
        if (entity === "messages") {
          const row = byId(id)
          if (row) {
            row.labels = data.labels
            row.is_read = data.isRead
          }
        }
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async (json: string) => {
        emitted.push(JSON.parse(json))
      },
      enqueueJob: async () => {},
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async (p: string) =>
        JSON.stringify({ id: "contact-1", email: JSON.parse(p).email }),
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              historyId: "2001",
              history: [
                {
                  id: "2000",
                  labelsRemoved: [
                    { message: { id: "gm-1" }, labelIds: ["UNREAD"] },
                    { message: { id: "gm-2" }, labelIds: ["UNREAD"] },
                  ],
                },
              ],
            }),
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      },
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-org" },
      bridge,
      timeoutMs: 30000,
    })

    // Both messages lost UNREAD, each with its OWN labels.
    const m1 = updates.find((u) => u.entity === "messages" && u.id === "m-1")
    const m2 = updates.find((u) => u.entity === "messages" && u.id === "m-2")
    expect(m1?.data).toMatchObject({ isRead: true, labels: ["INBOX"] })
    expect(m2?.data).toMatchObject({ isRead: true, labels: ["INBOX"] })
    // The conversation is read, rolled up once.
    const convUpdates = updates.filter((u) => u.entity === "conversations" && u.id === "conv-1")
    expect(convUpdates.length).toBe(1)
    expect(convUpdates[0].data.isRead).toBe(true)
    // And an open mail list is told so, not left with a stale unread dot.
    const convEvent = emitted.find((e) => e.entity === "conversation" && e.entityId === "conv-1")
    expect(convEvent?.data).toMatchObject({ id: "conv-1", isRead: true })
  })

  it("a message marked unread in Gmail becomes unread here", async () => {
    const updates: any[] = []
    const acc = {
      id: "acc-org",
      owner_type: "org",
      encryption_state: "none",
      owner_id: null,
      provider: "gmail",
      email_address: "support@acme.test",
      sync_status: "active",
      sync_state: { historyId: "123" },
      disconnected_at: null,
    }
    const row = {
      id: "m-1",
      conversation_id: "conv-1",
      account_id: "acc-org",
      labels: ["INBOX"],
      is_read: true,
      is_starred: false,
      sent_at: "2026-09-01T10:00:00.000Z",
      snippet: "first",
      enc_version: 0,
    }
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      hasOnlineUsers: async () => "true",
      log_info: async () => {},
      log_warn: async () => {},
      log_error: async () => {},
      db_findOne: async () => JSON.stringify(acc),
      db_findMany: async (entity: string) => {
        if (entity === "accounts") return JSON.stringify([acc])
        if (entity !== "messages") return JSON.stringify([])
        return JSON.stringify([row])
      },
      db_insert: async (_e: string, dataJson: string) =>
        JSON.stringify({ id: "gen-1", ...JSON.parse(dataJson) }),
      db_update: async (entity: string, id: string, dataJson: string) => {
        const data = JSON.parse(dataJson)
        updates.push({ entity, id, data })
        if (entity === "messages") {
          row.labels = data.labels
          row.is_read = data.isRead
        }
      },
      db_updateMany: async () => JSON.stringify({ count: 0 }),
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async () => {},
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      fetch: async (url: string) => {
        if (url.includes("/history")) {
          return JSON.stringify({
            status: 200,
            headers: {},
            body: JSON.stringify({
              historyId: "2001",
              history: [
                { id: "2000", labelsAdded: [{ message: { id: "gm-1" }, labelIds: ["UNREAD"] }] },
              ],
            }),
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      },
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "gmailIncrementalSync",
      params: { orgId: "org-1", accountId: "acc-org" },
      bridge,
      timeoutMs: 30000,
    })

    expect(updates.find((u) => u.entity === "messages")?.data.isRead).toBe(false)
    expect(updates.find((u) => u.entity === "conversations")?.data.isRead).toBe(false)
  })
})
