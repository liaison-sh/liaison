// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { hashIdentifier } from "../lib/hash-identifier"
import { createMockDb } from "../test-db"
import { audience_erasure_sweep } from "./audience-erasure-consumer"

interface Envelope {
  status: "completed" | "pending_approval" | "error"
  result?: unknown
  error?: { code: string; message: string }
}

interface FetchCall {
  url: string
  method: string
  body?: string
}

function makeFetch(responses: Array<{ status: number; body: string }>) {
  const calls: FetchCall[] = []
  let idx = 0
  const fetch = async (url: string, opts?: Record<string, unknown>) => {
    calls.push({
      url,
      method: String(opts?.method ?? "GET"),
      body: typeof opts?.body === "string" ? opts.body : undefined,
    })
    const resp = responses[idx++]
    if (!resp) throw new Error(`no mock fetch response for call ${idx} to ${url}`)
    return { status: resp.status, headers: {}, body: resp.body }
  }
  return { fetch, calls }
}

const EMAIL = "erase-me@example.com"
const EMAIL_SHA256 = await hashIdentifier("email", EMAIL)

function makeExecuteTool(
  pendingErasures: Array<{ emailSha256: string; reason: string; erasedAt: string }>,
) {
  return async (target: string, _args: Record<string, unknown>): Promise<Envelope> => {
    if (target === "database:db_read") {
      return { status: "completed", result: pendingErasures }
    }
    return { status: "error", error: { code: "not_mocked", message: `no mock for ${target}` } }
  }
}

describe("audience_erasure_sweep", () => {
  it("hashIdentifier('email', raw) agrees with the record's emailSha256 (hash-agreement cross-check with P3)", async () => {
    expect(await hashIdentifier("email", EMAIL)).toBe(
      createHash("sha256").update(EMAIL).digest("hex"),
    )
  })

  it("fires Meta remove-users with the matching emailSha256 for each managed audience", async () => {
    const db = createMockDb()
    const { fetch, calls } = makeFetch([
      { status: 200, body: JSON.stringify({ audience_id: "aud_1", num_received: 1 }) },
    ])
    const executeTool = makeExecuteTool([
      { emailSha256: EMAIL_SHA256, reason: "gdpr_erasure", erasedAt: "2026-07-01T00:00:00Z" },
    ])
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
    }
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_1"] },
      { db, fetch, executeTool, connections },
    )) as { processed: number; meta_removed: number }

    expect(result.processed).toBe(1)
    expect(result.meta_removed).toBe(1)
    const deleteCall = calls.find((c) => c.method === "DELETE")
    expect(deleteCall).toBeTruthy()
    expect(deleteCall?.url).toContain("aud_1/users")
    expect(deleteCall?.body).toContain(EMAIL_SHA256)
  })

  it("writes an audit record and marks the erasure consumed (audience_erasure_log)", async () => {
    const db = createMockDb()
    const { fetch } = makeFetch([{ status: 200, body: JSON.stringify({ num_received: 1 }) }])
    const executeTool = makeExecuteTool([
      { emailSha256: EMAIL_SHA256, reason: "gdpr_erasure", erasedAt: "2026-07-01T00:00:00Z" },
    ])
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
    }
    await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_1"] },
      { db, fetch, executeTool, connections },
    )

    const logRows = db.__all("audience_erasure_log")
    expect(logRows.length).toBeGreaterThan(0)
    expect(
      logRows.some(
        (r) => r.email_sha256 === EMAIL_SHA256 && r.platform === "meta" && r.status === "removed",
      ),
    ).toBe(true)
  })

  it("does not re-process an already-consumed record (idempotent by emailSha256)", async () => {
    const db = createMockDb({
      seed: {
        audience_erasure_log: [
          {
            id: "log_1",
            email_sha256: EMAIL_SHA256,
            platform: "meta",
            status: "removed",
            consumed_at: "2026-06-01T00:00:00Z",
          },
          {
            id: "log_2",
            email_sha256: EMAIL_SHA256,
            platform: "google",
            status: "removed",
            consumed_at: "2026-06-01T00:00:00Z",
          },
        ],
      },
    })
    const { fetch, calls } = makeFetch([])
    const executeTool = makeExecuteTool([
      { emailSha256: EMAIL_SHA256, reason: "gdpr_erasure", erasedAt: "2026-07-01T00:00:00Z" },
    ])
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
    }
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_1"] },
      { db, fetch, executeTool, connections },
    )) as { processed: number; skipped_already_consumed: number }

    expect(result.skipped_already_consumed).toBe(1)
    expect(calls.length).toBe(0) // no Meta call at all — already handled
  })

  it("absent Meta connection -> clean no-op + audit note (never a crash)", async () => {
    const db = createMockDb()
    const executeTool = makeExecuteTool([
      { emailSha256: EMAIL_SHA256, reason: "gdpr_erasure", erasedAt: "2026-07-01T00:00:00Z" },
    ])
    const connections = {} // no meta connection configured
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_1"] },
      {
        db,
        fetch: async () => {
          throw new Error("should not be called")
        },
        executeTool,
        connections,
      },
    )) as { meta_removed: number; meta_note?: string }

    expect(result.meta_removed).toBe(0)
    expect(result.meta_note).toBeTruthy()
    const logRows = db.__all("audience_erasure_log")
    expect(logRows.some((r) => r.status === "no_op_not_connected")).toBe(true)
  })

  it("Google Customer Match removal fires an offlineUserDataJobs create+addOperations+run sequence", async () => {
    const db = createMockDb()
    const { fetch, calls } = makeFetch([
      // Meta remove
      { status: 200, body: JSON.stringify({ num_received: 1 }) },
      // Google: create job
      {
        status: 200,
        body: JSON.stringify({
          results: [{ resourceName: "customers/123/offlineUserDataJobs/1" }],
        }),
      },
      // Google: addOperations
      { status: 200, body: JSON.stringify({}) },
      // Google: run
      { status: 200, body: JSON.stringify({}) },
    ])
    const executeTool = makeExecuteTool([
      { emailSha256: EMAIL_SHA256, reason: "gdpr_erasure", erasedAt: "2026-07-01T00:00:00Z" },
    ])
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
      google: { getToken: async () => "oauth_tok" },
      "google-config": {
        getCredentials: async () => ({
          developerToken: "dev_tok",
          loginCustomerId: "1112223333",
          customerId: "1234567890",
          merchantId: "mc_1",
        }),
      },
    }
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_1"] },
      { db, fetch, executeTool, connections },
    )) as { google_removed: number }

    expect(result.google_removed).toBe(1)
    expect(calls.some((c) => c.url.includes("offlineUserDataJobs"))).toBe(true)
    const logRows = db.__all("audience_erasure_log")
    expect(logRows.some((r) => r.platform === "google" && r.status === "removed")).toBe(true)
  })

  it("absent Google connection -> clean no-op for the Google arm, Meta arm still proceeds", async () => {
    const db = createMockDb()
    const { fetch } = makeFetch([{ status: 200, body: JSON.stringify({ num_received: 1 }) }])
    const executeTool = makeExecuteTool([
      { emailSha256: EMAIL_SHA256, reason: "gdpr_erasure", erasedAt: "2026-07-01T00:00:00Z" },
    ])
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
    }
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_1"] },
      { db, fetch, executeTool, connections },
    )) as { meta_removed: number; google_removed: number; google_note?: string }

    expect(result.meta_removed).toBe(1)
    expect(result.google_removed).toBe(0)
    expect(result.google_note).toBeTruthy()
  })

  it("Meta connected but no managed_meta_audience_ids -> no_op_no_audience_ids (distinct from not-connected)", async () => {
    const db = createMockDb()
    const executeTool = makeExecuteTool([
      { emailSha256: EMAIL_SHA256, reason: "gdpr_erasure", erasedAt: "2026-07-01T00:00:00Z" },
    ])
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
    }
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: [] },
      {
        db,
        fetch: async () => {
          throw new Error("should not be called -- no audience ids to DELETE against")
        },
        executeTool,
        connections,
      },
    )) as { meta_removed: number; meta_note?: string }

    expect(result.meta_removed).toBe(0)
    expect(result.meta_note).toMatch(/no managed_meta_audience_ids/)
    const logRows = db.__all("audience_erasure_log")
    // Scope to the meta platform -- the google arm (no google connection
    // configured in this test) independently writes its own
    // no_op_not_connected row, which is expected and unrelated to Meta's
    // no_op_no_audience_ids distinction being asserted here.
    const metaRows = logRows.filter((r) => r.platform === "meta")
    expect(metaRows.some((r) => r.status === "no_op_no_audience_ids")).toBe(true)
    expect(metaRows.some((r) => r.status === "no_op_not_connected")).toBe(false)
  })

  it("a mid-batch Meta DELETE failure for one audience does not abort the others -- partial failure, audited", async () => {
    const db = createMockDb()
    let call = 0
    const fetch = async (url: string, opts?: Record<string, unknown>) => {
      call++
      if (String(opts?.method ?? "GET") === "DELETE" && url.includes("aud_bad")) {
        throw new Error("Meta API 500")
      }
      return { status: 200, headers: {}, body: JSON.stringify({ num_received: 1 }) }
    }
    const executeTool = makeExecuteTool([
      { emailSha256: EMAIL_SHA256, reason: "gdpr_erasure", erasedAt: "2026-07-01T00:00:00Z" },
    ])
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
    }
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_good", "aud_bad"] },
      { db, fetch, executeTool, connections },
    )) as { meta_removed: number; meta_note?: string; processed: number }

    expect(call).toBeGreaterThan(0)
    // removed=true only when ALL audiences succeed -- one failure means the
    // email is NOT counted as removed even though aud_good's DELETE landed.
    expect(result.meta_removed).toBe(0)
    expect(result.meta_note).toMatch(/aud_bad/)
    expect(result.processed).toBe(1)
    const logRows = db.__all("audience_erasure_log")
    const failedRow = logRows.find((r) => r.platform === "meta" && r.status === "failed")
    expect(failedRow).toBeTruthy()
    expect((failedRow?.failed_audience_ids as string[] | undefined)?.includes("aud_bad")).toBe(true)
  })

  it("a mid-batch failure for one erasure record does not abort the sweep of subsequent records", async () => {
    const db = createMockDb()
    const email2 = await hashIdentifier("email", "second@example.com")
    let dbCallCount = 0
    const brokenDb = {
      ...db,
      findMany: async (entity: string, opts?: Record<string, unknown>) => {
        dbCallCount++
        // Throw only on the very first alreadyConsumed lookup (simulates a
        // transient error for the first erasure in the batch).
        if (entity === "audience_erasure_log" && dbCallCount === 1) {
          throw new Error("transient DB error")
        }
        return db.findMany(entity, opts as never)
      },
    }
    const { fetch } = makeFetch([{ status: 200, body: JSON.stringify({ num_received: 1 }) }])
    const executeTool = makeExecuteTool([
      { emailSha256: EMAIL_SHA256, reason: "gdpr_erasure", erasedAt: "2026-07-01T00:00:00Z" },
      { emailSha256: email2, reason: "gdpr_erasure", erasedAt: "2026-07-01T00:00:00Z" },
    ])
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
    }
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_1"] },
      { db: brokenDb as never, fetch, executeTool, connections },
    )) as { meta_removed: number; erasures_failed: number }

    // The first record's alreadyConsumed lookup throws; the sweep must still
    // process the second record's Meta removal rather than aborting the batch.
    expect(result.meta_removed).toBe(1)
    expect(result.erasures_failed).toBe(1)
  })

  it("no pending erasures -> clean no-op, no fetch calls", async () => {
    const db = createMockDb()
    const { fetch, calls } = makeFetch([])
    const executeTool = makeExecuteTool([])
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
    }
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_1"] },
      { db, fetch, executeTool, connections },
    )) as {
      processed: number
    }
    expect(result.processed).toBe(0)
    expect(calls.length).toBe(0)
  })

  it("consumes the REAL curated-read envelope: { rows } wrapper with snake_case columns (staging shape)", async () => {
    const db = createMockDb()
    const { fetch, calls } = makeFetch([{ status: 200, body: JSON.stringify({ num_received: 1 }) }])
    const executeTool = async (target: string): Promise<Envelope> => {
      if (target === "database:db_read") {
        return {
          status: "completed",
          result: {
            rows: [
              {
                email_sha256: EMAIL_SHA256,
                reason: "gdpr_erasure",
                erased_at: "2026-07-01T00:00:00Z",
              },
            ],
            truncated: false,
          },
        }
      }
      return { status: "error", error: { code: "not_mocked", message: `no mock for ${target}` } }
    }
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
    }
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_1"] },
      { db, fetch, executeTool, connections },
    )) as { processed: number; meta_removed: number }
    expect(result.processed).toBe(1)
    expect(result.meta_removed).toBe(1)
    expect(calls.some((c) => c.method === "DELETE")).toBe(true)
  })

  it("falls back to database:db_query when the curated pending_audience_erasures read errors", async () => {
    const db = createMockDb()
    const { fetch, calls } = makeFetch([{ status: 200, body: JSON.stringify({ num_received: 1 }) }])
    const executeTool = async (target: string): Promise<Envelope> => {
      if (target === "database:db_read")
        return { status: "error", error: { code: "not_found", message: "no such read" } }
      if (target === "database:db_query") {
        return {
          status: "completed",
          result: [
            { emailSha256: EMAIL_SHA256, reason: "gdpr_erasure", erasedAt: "2026-07-01T00:00:00Z" },
          ],
        }
      }
      return { status: "error", error: { code: "not_mocked", message: `no mock for ${target}` } }
    }
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
    }
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_1"] },
      { db, fetch, executeTool, connections },
    )) as { processed: number; meta_removed: number }

    expect(result.processed).toBe(1)
    expect(result.meta_removed).toBe(1)
    expect(calls.some((c) => c.method === "DELETE")).toBe(true)
  })

  it("degrades cleanly (poll_degraded, no crash) when both the curated read and db_query fallback fail", async () => {
    const db = createMockDb()
    const executeTool = async (target: string): Promise<Envelope> => ({
      status: "error",
      error: { code: "connect_error", message: `${target} not connected` },
    })
    const connections = {
      meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
    }
    const result = (await audience_erasure_sweep(
      { managed_meta_audience_ids: ["aud_1"] },
      {
        db,
        fetch: async () => {
          throw new Error("should not be called")
        },
        executeTool,
        connections,
      },
    )) as { processed: number; poll_degraded?: boolean; poll_note?: string }

    expect(result.processed).toBe(0)
    expect(result.poll_degraded).toBe(true)
    expect(result.poll_note).toBeTruthy()
  })
})
