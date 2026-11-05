// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { ParsedAttachment } from "~/lib/email/types"
import {
  gmailFetchByRfc822MessageId,
  gmailIncrementalSync,
  gmailInitialSync,
  hydrateGmailAttachments,
  imapIncrementalSync,
  imapInitialSync,
  type ProcessMessageFn,
  type SyncCtx,
} from "./sync"

/**
 * Run `fn` with GMAIL_PUBSUB_TOPIC pinned. Any test that exercises the watch
 * path must set it explicitly: with no topic the sync deliberately skips the
 * watch call, so inheriting the ambient value makes the test pass or fail
 * depending on the machine it runs on.
 */
async function withPushTopic(topic: string | null, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.GMAIL_PUBSUB_TOPIC
  if (topic === null) delete process.env.GMAIL_PUBSUB_TOPIC
  else process.env.GMAIL_PUBSUB_TOPIC = topic
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.GMAIL_PUBSUB_TOPIC
    else process.env.GMAIL_PUBSUB_TOPIC = prev
  }
}

function makeCtx(overrides: Partial<SyncCtx> = {}): SyncCtx {
  return {
    fetch: globalThis.fetch,
    getAccessToken: async () => "tok",
    enqueueJob: async () => {},
    imapFetch: async () => ({ messages: [], cursor: undefined }),
    loadAccount: async () => ({
      id: "ca-1",
      email_address: "support@x.test",
      metadata: { gmail: { historyId: "100" } },
      status: "active",
    }),
    saveAccountMetadata: async () => {},
    loadInboxByAccountId: async () => ({
      id: "inbox-1",
      email_address: "support@x.test",
      org_id: "org-1",
    }),
    ...overrides,
  }
}

describe("gmailIncrementalSync", () => {
  it("returns no_cursor when historyId is missing", async () => {
    let enqueued = false
    const ctx = makeCtx({
      loadAccount: async () => ({
        id: "ca",
        email_address: "support@x.test",
        metadata: {},
        status: "active",
      }),
      enqueueJob: async (name) => {
        if (name === "gmail-initial-sync") enqueued = true
      },
    })
    const r = await gmailIncrementalSync("org", "ca-1", ctx)
    expect(r.processed).toBe(0)
    expect(r.dropped[0].reason).toBe("no_cursor")
    expect(enqueued).toBe(true)
  })

  it("advances cursor after batch processed", async () => {
    let saved: Record<string, unknown> = {}
    const calls: string[] = []
    const ctx = makeCtx({
      fetch: (async (url: string) => {
        if (String(url).includes("/history?")) {
          calls.push("history")
          return new Response(
            JSON.stringify({
              history: [{ messagesAdded: [{ message: { id: "m1" } }] }],
              historyId: "200",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (String(url).includes("/messages/")) {
          calls.push("get")
          return new Response(
            JSON.stringify({
              id: "m1",
              payload: {
                headers: [
                  { name: "Message-Id", value: "<m1@x.test>" },
                  { name: "From", value: "a@x.test" },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        return new Response("not-found", { status: 404 })
      }) as unknown as typeof fetch,
      saveAccountMetadata: async (_id, meta) => {
        saved = meta
      },
    })
    const processMessage: ProcessMessageFn = async () => ({
      outcome: "created",
      ticketId: "t1",
      messageId: "msg",
    })
    const r = await gmailIncrementalSync("org", "ca", ctx, { processMessage })
    expect(r.processed).toBe(1)
    expect((saved.gmail as { historyId: string }).historyId).toBe("200")
    expect(calls).toEqual(["history", "get"])
  })

  it("404 history clears cursor and enqueues initial-sync", async () => {
    let enqueued = false
    let saved: Record<string, unknown> | null = null
    const ctx = makeCtx({
      fetch: (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch,
      enqueueJob: async (name) => {
        if (name === "gmail-initial-sync") enqueued = true
      },
      saveAccountMetadata: async (_id, meta) => {
        saved = meta
      },
    })
    const r = await gmailIncrementalSync("org", "ca", ctx)
    expect(r.dropped[0].reason).toBe("history_id_invalid")
    expect(enqueued).toBe(true)
    expect((saved as { gmail: Record<string, unknown> } | null)?.gmail).toEqual({})
  })

  it("mid-batch message-fetch failure is counted as dropped and cursor still advances", async () => {
    // A 500 on the per-message fetch must not abort the whole batch. The
    // failed message is counted as `dropped`, the new historyId is still
    // written, and the function resolves rather than rejecting.
    let saved: Record<string, unknown> | null = null
    const ctx = makeCtx({
      fetch: (async (url: string) => {
        if (String(url).includes("/history?")) {
          return new Response(
            JSON.stringify({
              history: [{ messagesAdded: [{ message: { id: "m1" } }] }],
              historyId: "200",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        return new Response("oops", { status: 500 })
      }) as unknown as typeof fetch,
      saveAccountMetadata: async (_id, meta) => {
        saved = meta
      },
    })
    const result = await gmailIncrementalSync("org", "ca", ctx)
    // The failed message is counted as dropped, not as a hard error.
    expect(result.dropped.some((d) => d.reason.startsWith("fetch_error"))).toBe(true)
    expect(result.processed).toBe(0)
    // The cursor must have been advanced to historyId "200" even though the
    // message fetch failed — otherwise the same message blocks future syncs.
    expect((saved as { gmail?: { historyId?: string } } | null)?.gmail?.historyId).toBe("200")
  })

  it("rerouted_failed leaves incremental cursor unchanged", async () => {
    let saved: Record<string, unknown> | null = null
    const ctx = makeCtx({
      fetch: (async (url: string) => {
        if (String(url).includes("/history?")) {
          return new Response(
            JSON.stringify({
              history: [{ messagesAdded: [{ message: { id: "m1" } }] }],
              historyId: "200",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (String(url).includes("/messages/")) {
          return new Response(JSON.stringify({ id: "m1", payload: { headers: [] } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response("not-found", { status: 404 })
      }) as unknown as typeof fetch,
      saveAccountMetadata: async (_id, meta) => {
        saved = meta
      },
    })
    const r = await gmailIncrementalSync("org", "ca", ctx, {
      processMessage: async () => ({
        outcome: "rerouted_failed",
        conversationId: "c1",
        reason: "forbidden",
      }),
    })
    expect(saved).toBeNull()
    expect(r.reroutedFailed).toEqual([{ reason: "forbidden", count: 1 }])
  })

  it("rerouted_failed leaves initial sync watch cursor unchanged", async () => {
    let saved: Record<string, unknown> | null = null
    const ctx = makeCtx({
      fetch: (async (url: string) => {
        if (String(url).includes("/messages?q=")) {
          return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        if (String(url).includes("/messages/")) {
          return new Response(JSON.stringify({ id: "m1", payload: { headers: [] } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        if (String(url).includes("/watch")) {
          return new Response(JSON.stringify({ historyId: "300", expiration: "999" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response("not-found", { status: 404 })
      }) as unknown as typeof fetch,
      saveAccountMetadata: async (_id, meta) => {
        saved = meta
      },
    })
    const r = await gmailInitialSync("org", "ca", ctx, {
      processMessage: async () => ({
        outcome: "rerouted_failed",
        conversationId: "c1",
        reason: "forbidden",
      }),
    })
    expect(saved).toBeNull()
    expect(r.reroutedFailed).toEqual([{ reason: "forbidden", count: 1 }])
  })

  it("with no Pub/Sub topic configured it does not call /watch at all", async () => {
    // gmailWatchBody() sends `{}` when GMAIL_PUBSUB_TOPIC is unset, and Gmail
    // answers `topicName required` (400). Observed live: that 400 happened on
    // EVERY sync. Calling an endpoint that cannot possibly succeed, then
    // swallowing its error, is not a fallback — it is a guaranteed round trip
    // to Google for nothing. Push simply is not configured; say so and move on.
    await withPushTopic(null, async () => {
      let watchCalls = 0
      let saved: Record<string, unknown> | null = null
      const ctx = makeCtx({
        fetch: (async (url: string) => {
          const u = String(url)
          if (u.includes("/messages?q=")) {
            return new Response(JSON.stringify({ messages: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          if (u.includes("/watch")) {
            watchCalls++
            return new Response(JSON.stringify({ error: { message: "topicName required" } }), {
              status: 400,
            })
          }
          if (u.includes("/profile")) {
            return new Response(JSON.stringify({ historyId: "777" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          return new Response("not-found", { status: 404 })
        }) as unknown as typeof fetch,
        saveAccountMetadata: async (_id, meta) => {
          saved = meta
        },
      })

      await gmailInitialSync("org", "ca", ctx, {
        processMessage: async () => ({ outcome: "dropped", reason: "x" }),
      })

      expect(watchCalls).toBe(0)
      // The cursor still gets set, so incremental sync works without push.
      expect((saved as { gmail?: { historyId?: string } } | null)?.gmail?.historyId).toBe("777")
    })
  })

  it("a FAILED watch still persists a cursor (from profile), so incremental sync is not dead forever", async () => {
    await withPushTopic("projects/p/topics/t", async () => {
      // Observed live on 2026-07-28: registering the Gmail push watch failed, so
      // the cursor was never written. Every incremental tick then found no cursor
      // and re-enqueued a FULL initial sync — a complete mailbox listing every 5
      // minutes, forever, while the incremental path never ran once. Mail still
      // arrived, which is exactly why nobody noticed.
      //
      // Push and the history cursor are separate concerns. Losing push must not
      // cost the cursor.
      let saved: Record<string, unknown> | null = null
      let profileCalls = 0
      const ctx = makeCtx({
        fetch: (async (url: string) => {
          const u = String(url)
          if (u.includes("/messages?q=")) {
            return new Response(JSON.stringify({ messages: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          if (u.includes("/watch")) {
            // What a missing Pub/Sub grant actually looks like.
            return new Response(JSON.stringify({ error: { message: "insufficient permission" } }), {
              status: 403,
              headers: { "Content-Type": "application/json" },
            })
          }
          if (u.includes("/profile")) {
            profileCalls++
            return new Response(JSON.stringify({ historyId: "424242" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          return new Response("not-found", { status: 404 })
        }) as unknown as typeof fetch,
        saveAccountMetadata: async (_id, meta) => {
          saved = meta
        },
      })

      await gmailInitialSync("org", "ca", ctx, {
        processMessage: async () => ({ outcome: "dropped", reason: "x" }),
      })

      expect(profileCalls).toBe(1)
      const gmail = (saved as { gmail?: Record<string, unknown> } | null)?.gmail
      expect(gmail?.historyId).toBe("424242")
      // No push registration succeeded, so nothing may claim an expiry — a stale
      // expiration would make the renewal cron think a live watch exists.
      expect(gmail?.expiration).toBeUndefined()
    })
  })

  it("a successful watch still wins: its historyId + expiration are what get stored", async () => {
    await withPushTopic("projects/p/topics/t", async () => {
      let saved: Record<string, unknown> | null = null
      let profileCalls = 0
      const ctx = makeCtx({
        fetch: (async (url: string) => {
          const u = String(url)
          if (u.includes("/messages?q=")) {
            return new Response(JSON.stringify({ messages: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          if (u.includes("/watch")) {
            return new Response(JSON.stringify({ historyId: "300", expiration: "999" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          if (u.includes("/profile")) {
            profileCalls++
            return new Response(JSON.stringify({ historyId: "424242" }), { status: 200 })
          }
          return new Response("not-found", { status: 404 })
        }) as unknown as typeof fetch,
        saveAccountMetadata: async (_id, meta) => {
          saved = meta
        },
      })

      await gmailInitialSync("org", "ca", ctx, {
        processMessage: async () => ({ outcome: "dropped", reason: "x" }),
      })

      // The fallback is a fallback: it must not fire when watch worked.
      expect(profileCalls).toBe(0)
      const gmail = (saved as { gmail?: Record<string, unknown> } | null)?.gmail
      expect(gmail?.historyId).toBe("300")
      expect(gmail?.expiration).toBe("999")
    })
  })

  it("both watch AND profile failing leaves the cursor unset rather than inventing one", async () => {
    await withPushTopic("projects/p/topics/t", async () => {
      // A fabricated cursor would make incremental sync skip everything between
      // the real position and the invented one — silent mail loss. Staying
      // cursor-less keeps re-running the (correct, if wasteful) initial sync.
      let saved: Record<string, unknown> | null = null
      const ctx = makeCtx({
        fetch: (async (url: string) => {
          const u = String(url)
          if (u.includes("/messages?q=")) {
            return new Response(JSON.stringify({ messages: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 403 })
        }) as unknown as typeof fetch,
        saveAccountMetadata: async (_id, meta) => {
          saved = meta
        },
      })
      await gmailInitialSync("org", "ca", ctx, {
        processMessage: async () => ({ outcome: "dropped", reason: "x" }),
      })
      expect(saved).toBeNull()
    })
  })

  it("gmailInitialSync honours TICKETS_GMAIL_SYNC_SINCE + paginates every page", async () => {
    const since = "2026-06-30T00:00:00Z"
    const sinceEpoch = Math.floor(Date.parse(since) / 1000)
    process.env.TICKETS_GMAIL_SYNC_SINCE = since
    const listUrls: string[] = []
    const fetchedIds: string[] = []
    try {
      const ctx = makeCtx({
        fetch: (async (url: string) => {
          const u = String(url)
          if (u.includes("/messages?")) {
            listUrls.push(u)
            // page 1 -> m1 + nextPageToken; page 2 (pageToken=PAGE2) -> m2, no token
            if (u.includes("pageToken=PAGE2")) {
              return new Response(JSON.stringify({ messages: [{ id: "m2" }] }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              })
            }
            return new Response(
              JSON.stringify({ messages: [{ id: "m1" }], nextPageToken: "PAGE2" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          }
          if (u.includes("/messages/")) {
            fetchedIds.push(u.split("/messages/")[1].split("?")[0])
            return new Response(JSON.stringify({ id: "x", payload: { headers: [] } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          if (u.includes("/watch")) {
            return new Response(JSON.stringify({ historyId: "300" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          return new Response("nf", { status: 404 })
        }) as unknown as typeof fetch,
      })
      const r = await gmailInitialSync("org", "ca", ctx, {
        processMessage: async () => ({ outcome: "created", ticketId: "t", messageId: "m" }),
      })
      // both pages were fetched + processed (pagination)
      expect(fetchedIds).toEqual(["m1", "m2"])
      expect(r.processed).toBe(2)
      // the list query started from the absolute SINCE epoch, not a rolling 30-day lookback
      expect(decodeURIComponent(listUrls[0])).toContain(`after:${sinceEpoch}`)
      // and it followed the nextPageToken to page 2
      expect(listUrls.some((u) => u.includes("pageToken=PAGE2"))).toBe(true)
    } finally {
      delete process.env.TICKETS_GMAIL_SYNC_SINCE
    }
  })
})

describe("imapIncrementalSync", () => {
  it("UIDVALIDITY change clears cursor and enqueues initial sync", async () => {
    let saved: Record<string, unknown> | null = null
    let enqueued = false
    const ctx = makeCtx({
      loadAccount: async () => ({
        id: "ca",
        email_address: "a@x.test",
        metadata: { imap: { cursor: "5", uidValidity: "1" } },
        status: "active",
      }),
      imapFetch: async () => ({
        messages: [],
        cursor: undefined,
        uidValidity: "999",
      }),
      saveAccountMetadata: async (_id, meta) => {
        saved = meta
      },
      enqueueJob: async (name) => {
        if (name === "imap-initial-sync") enqueued = true
      },
    })
    const r = await imapIncrementalSync("org", "ca", ctx)
    expect(r.dropped[0].reason).toBe("uidvalidity_changed")
    expect((saved as null | { imap?: { uidValidity?: string } })?.imap?.uidValidity).toBe("999")
    expect(enqueued).toBe(true)
  })

  it("processes messages and advances cursor", async () => {
    let saved: { imap?: { cursor?: string } } | null = null
    const ctx = makeCtx({
      loadAccount: async () => ({
        id: "ca",
        email_address: "a@x.test",
        metadata: { imap: { cursor: "5", uidValidity: "1" } },
        status: "active",
      }),
      imapFetch: async () => ({
        messages: [
          {
            messageId: "<i1>",
            from: { email: "a@x.test" },
            subject: "Hi",
          },
        ],
        cursor: "10",
        uidValidity: "1",
      }),
      saveAccountMetadata: async (_id, meta) => {
        saved = meta as { imap?: { cursor?: string } }
      },
    })
    const r = await imapIncrementalSync("org", "ca", ctx, {
      processMessage: async () => ({ outcome: "created", ticketId: "t", messageId: "m" }),
    })
    expect(r.processed).toBe(1)
    expect((saved as null | { imap?: { cursor?: string } })?.imap?.cursor).toBe("10")
  })

  it("rerouted_failed leaves incremental cursor unchanged", async () => {
    let saved: { imap?: { cursor?: string } } | null = null
    const ctx = makeCtx({
      loadAccount: async () => ({
        id: "ca",
        email_address: "a@x.test",
        metadata: { imap: { cursor: "5", uidValidity: "1" } },
        status: "active",
      }),
      imapFetch: async () => ({
        messages: [{ messageId: "<i1>", from: { email: "a@x.test" }, subject: "Hi" } as any],
        cursor: "10",
        uidValidity: "1",
      }),
      saveAccountMetadata: async (_id, meta) => {
        saved = meta as { imap?: { cursor?: string } }
      },
    })
    const r = await imapIncrementalSync("org", "ca", ctx, {
      processMessage: async () => ({
        outcome: "rerouted_failed",
        conversationId: "c1",
        reason: "forbidden",
      }),
    })
    expect(saved).toBeNull()
    expect(r.reroutedFailed).toEqual([{ reason: "forbidden", count: 1 }])
  })

  it("rerouted_failed leaves initial cursor unchanged", async () => {
    let saved: { imap?: { cursor?: string } } | null = null
    const ctx = makeCtx({
      imapFetch: async () => ({
        messages: [{ messageId: "<i1>", from: { email: "a@x.test" }, subject: "Hi" } as any],
        cursor: "10",
        uidValidity: "1",
      }),
      saveAccountMetadata: async (_id, meta) => {
        saved = meta as { imap?: { cursor?: string } }
      },
    })
    const r = await imapInitialSync("org", "ca", ctx, {
      processMessage: async () => ({
        outcome: "rerouted_failed",
        conversationId: "c1",
        reason: "forbidden",
      }),
    })
    expect(saved).toBeNull()
    expect(r.reroutedFailed).toEqual([{ reason: "forbidden", count: 1 }])
  })
})

describe("hydrateGmailAttachments", () => {
  const attachmentPart = (overrides: Partial<ParsedAttachment> = {}): ParsedAttachment => ({
    filename: "clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1024,
    providerAttachmentId: "att-1",
    disposition: "attachment",
    ...overrides,
  })

  it("fetches provider-id bytes and normalizes base64url to base64", async () => {
    const fetched: string[] = []
    const ctx = makeCtx({
      fetch: (async (url: string) => {
        fetched.push(String(url))
        return new Response(JSON.stringify({ size: 6, data: "-_-_AB" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }) as unknown as typeof fetch,
    })
    const parsed = { attachments: [attachmentPart()] }
    await hydrateGmailAttachments(ctx, "support@x.test", "gm-1", parsed as never)
    expect(fetched[0]).toContain("/messages/gm-1/attachments/att-1")
    expect(parsed.attachments[0].bytesBase64).toBe("+/+/AB")
  })

  it("skips parts that already carry bytes and parts over the per-attachment cap", async () => {
    let calls = 0
    const ctx = makeCtx({
      fetch: (async () => {
        calls += 1
        return new Response(JSON.stringify({ data: "QUJD" }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const parsed = {
      attachments: [
        attachmentPart({ bytesBase64: "QUJD", providerAttachmentId: undefined }),
        attachmentPart({ sizeBytes: 26 * 1024 * 1024 }),
        attachmentPart({ providerAttachmentId: undefined, sizeBytes: undefined }),
      ],
    }
    await hydrateGmailAttachments(ctx, "support@x.test", "gm-1", parsed as never)
    expect(calls).toBe(0)
    expect(parsed.attachments[1].bytesBase64).toBeUndefined()
  })

  it("a failed attachment fetch leaves the part byte-less without throwing", async () => {
    const ctx = makeCtx({
      fetch: (async () => new Response("oops", { status: 500 })) as unknown as typeof fetch,
    })
    const parsed = { attachments: [attachmentPart()] }
    await hydrateGmailAttachments(ctx, "support@x.test", "gm-1", parsed as never)
    expect(parsed.attachments[0].bytesBase64).toBeUndefined()
  })

  it("incremental sync hands processFn attachments with hydrated bytes", async () => {
    let seen: unknown
    const ctx = makeCtx({
      fetch: (async (url: string) => {
        const u = String(url)
        if (u.includes("/history?")) {
          return new Response(
            JSON.stringify({
              history: [{ messagesAdded: [{ message: { id: "m1" } }] }],
              historyId: "200",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (u.includes("/attachments/")) {
          return new Response(JSON.stringify({ size: 3, data: "QUJD" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        if (u.includes("/messages/")) {
          return new Response(
            JSON.stringify({
              id: "m1",
              payload: {
                headers: [{ name: "Message-Id", value: "<m1@x.test>" }],
                parts: [
                  {
                    filename: "clip.mp4",
                    mimeType: "video/mp4",
                    body: { attachmentId: "att-1", size: 3 },
                  },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        return new Response("not-found", { status: 404 })
      }) as unknown as typeof fetch,
    })
    const processMessage: ProcessMessageFn = async (parsed) => {
      seen = parsed.attachments
      return { outcome: "created", ticketId: "t1", messageId: "msg" }
    }
    const r = await gmailIncrementalSync("org", "ca", ctx, { processMessage })
    expect(r.processed).toBe(1)
    expect(seen).toEqual([
      expect.objectContaining({
        filename: "clip.mp4",
        providerAttachmentId: "att-1",
        bytesBase64: "QUJD",
      }),
    ])
  })
})

describe("gmailFetchByRfc822MessageId", () => {
  it("searches by rfc822msgid (brackets stripped), fetches and hydrates", async () => {
    const urls: string[] = []
    const ctx = makeCtx({
      fetch: (async (url: string) => {
        const u = String(url)
        urls.push(u)
        if (u.includes("/messages?")) {
          return new Response(JSON.stringify({ messages: [{ id: "gm-9" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        if (u.includes("/attachments/")) {
          return new Response(JSON.stringify({ data: "QUJD" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response(
          JSON.stringify({
            id: "gm-9",
            payload: {
              headers: [{ name: "Message-Id", value: "<m9@x.test>" }],
              parts: [
                {
                  filename: "clip.mp4",
                  mimeType: "video/mp4",
                  body: { attachmentId: "att-9", size: 3 },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }) as unknown as typeof fetch,
    })
    const parsed = await gmailFetchByRfc822MessageId(ctx, "support@x.test", "<m9@x.test>")
    expect(urls[0]).toContain(encodeURIComponent("rfc822msgid:m9@x.test"))
    expect(parsed?.attachments?.[0]?.bytesBase64).toBe("QUJD")
  })

  it("returns null when the mailbox has no such message", async () => {
    const ctx = makeCtx({
      fetch: (async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    })
    expect(await gmailFetchByRfc822MessageId(ctx, "support@x.test", "<none@x.test>")).toBeNull()
  })
})

// A first sync ingests up to a month of an existing mailbox: none of that mail
// may be acknowledged as if it had just arrived. Each sync says which it is.
describe("backfill flag passed to the message processor", () => {
  const imapMessage = { messageId: "<b1>", from: { email: "a@x.test" }, subject: "Hi" }
  function recorder(): { seen: Array<boolean | undefined>; fn: ProcessMessageFn } {
    const seen: Array<boolean | undefined> = []
    return {
      seen,
      fn: async (_parsed, _inbox, opts) => {
        seen.push(opts?.backfill)
        return { outcome: "created", ticketId: "t", messageId: "m" }
      },
    }
  }

  it("an IMAP initial sync is a backfill; an incremental one is not", async () => {
    const ctx = makeCtx({
      imapFetch: async () => ({ messages: [imapMessage], cursor: "10", uidValidity: "1" }),
    })
    const initial = recorder()
    await imapInitialSync("org", "ca", ctx, { processMessage: initial.fn })
    expect(initial.seen).toEqual([true])
    const incremental = recorder()
    await imapIncrementalSync("org", "ca", ctx, { processMessage: incremental.fn })
    expect(incremental.seen).toEqual([false])
  })

  it("a Gmail initial sync is a backfill", async () => {
    const ctx = makeCtx({
      fetch: (async (url: string) => {
        if (String(url).includes("/messages?q=")) {
          return Response.json({ messages: [{ id: "m1" }] })
        }
        if (String(url).includes("/messages/")) {
          return Response.json({ id: "m1", payload: { headers: [] } })
        }
        return Response.json({ historyId: "300" })
      }) as unknown as typeof fetch,
    })
    const initial = recorder()
    await withPushTopic(null, async () => {
      await gmailInitialSync("org", "ca", ctx, { processMessage: initial.fn })
    })
    expect(initial.seen).toEqual([true])
  })
})
