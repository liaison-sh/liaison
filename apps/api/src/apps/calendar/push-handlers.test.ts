// SPDX-License-Identifier: FSL-1.1-ALv2
// Task 5 (coverage) — drives the push handlers (calendarPush -> pushCreate/pushUpdate/
// pushDelete) through the core module, mocking the ctx.fetch seam. The host-side sync.ts
// helpers are unit-tested in outbound-sync.test.ts; this file covers the handler behavior
// the review flagged as untested: the get->merge->PUT sequence, the If-Match header value, the
// bounded 412 retry recursion (attempt < 2, capped at 3 total), sendUpdates=none on every write,
// and preservation of an unmodelled Google-only field (colorId) across the update round-trip.
import { describe, expect, it } from "bun:test"
import { CORE_APP_MODULES } from "~/modules/apps/core/registry"
import { runCoreHandler } from "~/modules/apps/core/run-core"

/** Runs one calendar handler the way runApp does: the core module's export, in process. */
function runCalendar(opts: {
  exportName: string
  params: unknown
  bridge: Record<string, any>
  extraArgs?: unknown[]
  timeoutMs?: number
}): Promise<unknown> {
  return runCoreHandler({
    module: CORE_APP_MODULES.calendar!,
    appName: "calendar",
    holdsTx: false,
    ...opts,
  })
}

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function makeEventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt-local-1",
    calendar_id: "cal-1",
    google_event_id: null,
    etag: null,
    title: "Standup",
    description: "Daily sync",
    location: null,
    start: { dateTime: "2026-07-06T09:00:00Z" },
    end: { dateTime: "2026-07-06T09:30:00Z" },
    all_day: false,
    attendees: null,
    recurrence: null,
    liaison_sync_version: 1,
    pending_push: "create",
    ...overrides,
  }
}

/**
 * makeBridge — a mock bridge for the calendar push handlers. `fetchResponses` is a function that,
 * given the fetch call, returns the `{status, headers, body}` (as ctx.fetch answers it, JSON string).
 */
function makeBridge(opts: {
  event: Record<string, unknown>
  fetchResponses: (
    call: FetchCall,
    index: number,
  ) => { status: number; headers?: Record<string, string>; body?: unknown }
  currentEvent?: () => Record<string, unknown>
  conflictOutcome?: "remote-won" | "retry" | "abort-stale"
  /** Failed attempts already counted on the row (calendar_notePushFailure returns this + 1);
   * null = the row was edited since the push read it. */
  priorAttempts?: number | null
  /** How long this version has been failing (calendar_notePushFailure's failingForMs). */
  failingForMs?: number
  /** calendar_restoreRefusedDelete's answer: the delete had superseded a pending local edit. */
  pendingRestored?: boolean
}) {
  const fetches: FetchCall[] = []
  const pushResults: unknown[] = []
  const pushFailures: Array<{ errorKind: string; detail: string }> = []
  const conflictCalls: unknown[] = []
  const reverts: Array<{ remote: unknown; detail: string }> = []
  const enqueued: Array<{ jobName: string; payload: any; opts: any }> = []
  const finalizedDeletes: string[] = []
  const restores: Array<{
    eventId: string
    message: string
    syncVersion: number
    remote: unknown
  }> = []
  const deletions: string[] = []
  const rejections: Array<{ eventId: string; message: string }> = []
  /** The row version each terminal call was conditioned on (deletion / rejection / revert). */
  const versions: Array<{ call: string; syncVersion: unknown }> = []
  let fetchIndex = 0

  const bridge: Record<string, any> = {
    getUserId: () => "system:calendar:push",
    enqueueJob: async (jobName: string, payloadJson: string, optsJson?: string) => {
      enqueued.push({
        jobName,
        payload: JSON.parse(payloadJson),
        opts: optsJson ? JSON.parse(optsJson) : undefined,
      })
    },
    getOrgId: () => "org-1",
    calendar_getEvent: async (_eventId: string) =>
      JSON.stringify(opts.currentEvent ? opts.currentEvent() : opts.event),
    calendar_getCalendar: async (_calendarId: string) =>
      JSON.stringify({ google_calendar_id: "gcal-1", account_id: "acc-1" }),
    calendar_getAccount: async (_accountId: string) =>
      JSON.stringify({ email_address: "test@gmail.com" }),
    connections_getToken: async () => "mock-token",
    fetch: async (url: string, optsJson: string) => {
      const parsed = JSON.parse(optsJson) as {
        method?: string
        headers?: Record<string, string>
        body?: string
      }
      const call: FetchCall = {
        url,
        method: parsed.method ?? "GET",
        headers: parsed.headers ?? {},
        body: parsed.body ? JSON.parse(parsed.body) : undefined,
      }
      fetches.push(call)
      const res = opts.fetchResponses(call, fetchIndex++)
      return JSON.stringify({
        status: res.status,
        headers: res.headers ?? {},
        body: typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? {}),
      })
    },
    calendar_applyPushResult: async (_eventId: string, resultJson: string) => {
      pushResults.push(JSON.parse(resultJson))
    },
    calendar_handlePushConflict: async (_eventId: string, inputJson: string) => {
      conflictCalls.push(JSON.parse(inputJson))
      return JSON.stringify({ outcome: opts.conflictOutcome ?? "retry" })
    },
    calendar_finalizeRemoteDelete: async (eventId: string) => {
      finalizedDeletes.push(eventId)
    },
    calendar_restoreRefusedDelete: async (
      eventId: string,
      message: string,
      syncVersion: number,
      remoteJson: string,
    ) => {
      restores.push({ eventId, message, syncVersion, remote: JSON.parse(remoteJson) })
      return JSON.stringify({ pendingRestored: opts.pendingRestored === true })
    },
    calendar_notePushFailure: async () =>
      JSON.stringify(
        opts.priorAttempts === null
          ? null
          : { attempts: (opts.priorAttempts ?? 0) + 1, failingForMs: opts.failingForMs ?? 0 },
      ),
    calendar_applyRemoteDeletion: async (eventId: string, syncVersion?: number) => {
      deletions.push(eventId)
      versions.push({ call: "delete", syncVersion })
    },
    calendar_markPushRejected: async (eventId: string, message: string, syncVersion?: number) => {
      rejections.push({ eventId, message })
      versions.push({ call: "reject", syncVersion })
    },
    calendar_revertToRemote: async (
      _eventId: string,
      remoteJson: string,
      detail: string,
      syncVersion?: number,
    ) => {
      reverts.push({ remote: JSON.parse(remoteJson), detail })
      versions.push({ call: "revert", syncVersion })
    },
    calendar_recordPushFailure: async (
      _eventId: string,
      _calendarId: string,
      errorKind: string,
      detail: string,
    ) => {
      pushFailures.push({ errorKind, detail })
    },
    log_info: () => {},
    log_warn: () => {},
    log_error: () => {},
  }

  return {
    bridge,
    fetches,
    pushResults,
    pushFailures,
    conflictCalls,
    reverts,
    enqueued,
    deletions,
    rejections,
    versions,
    finalizedDeletes,
    restores,
  }
}

describe("calendar push handlers (core module, ctx.fetch seam)", () => {
  async function runPush(bridge: Record<string, any>, payload: unknown): Promise<void> {
    await runCalendar({
      exportName: "calendarPush",
      params: payload,
      bridge,
      timeoutMs: 15000,
    })
  }

  it("create: POSTs events.insert with sendUpdates=none + liaison markers, stores googleEventId/etag", async () => {
    const m = makeBridge({
      event: makeEventRow(),
      fetchResponses: () => ({
        status: 200,
        body: { id: "gevt-created", etag: '"etag-created"', updated: "2026-07-06T00:00:00.000Z" },
      }),
    })
    await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })

    expect(m.fetches).toHaveLength(1)
    const insert = m.fetches[0]!
    expect(insert.method).toBe("POST")
    expect(insert.url).toContain("/events?sendUpdates=none")
    const body = insert.body as { extendedProperties?: { private?: Record<string, string> } }
    expect(body.extendedProperties?.private?.liaisonSource).toBe("liaison")
    expect(body.extendedProperties?.private?.liaisonEventId).toBe("evt-local-1")
    expect(m.pushResults[0]).toMatchObject({
      googleEventId: "gevt-created",
      etag: '"etag-created"',
    })
  })

  it("update: GET then PUT with If-Match=stored etag, sendUpdates=none, preserving an unmodelled remote field (colorId)", async () => {
    const event = makeEventRow({
      google_event_id: "gevt-1",
      etag: '"stored-etag"',
      pending_push: "update",
      title: "Updated title",
    })
    const m = makeBridge({
      event,
      fetchResponses: (call) => {
        if (call.method === "GET") {
          return {
            status: 200,
            body: {
              id: "gevt-1",
              etag: '"stored-etag"',
              summary: "Old title",
              colorId: "11",
              extendedProperties: { shared: { team: "eng" }, private: { foreign: "keep" } },
            },
          }
        }
        // PUT
        return {
          status: 200,
          body: { id: "gevt-1", etag: '"new-etag"', updated: "2026-07-06T01:00:00.000Z" },
        }
      },
    })
    await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })

    expect(m.fetches).toHaveLength(2)
    const get = m.fetches[0]!
    const put = m.fetches[1]!
    expect(get.method).toBe("GET")
    expect(put.method).toBe("PUT")
    expect(put.url).toContain("sendUpdates=none")
    // If-Match sourced from the fresh GET's etag.
    expect(put.headers["If-Match"]).toBe('"stored-etag"')
    const body = put.body as {
      summary?: string
      colorId?: string
      extendedProperties?: { shared?: Record<string, string>; private?: Record<string, string> }
    }
    // Local change applied, unmodelled remote field preserved.
    expect(body.summary).toBe("Updated title")
    expect(body.colorId).toBe("11")
    // extendedProperties deep-merged: remote shared + foreign private survive, our markers added.
    expect(body.extendedProperties?.shared?.team).toBe("eng")
    expect(body.extendedProperties?.private?.foreign).toBe("keep")
    expect(body.extendedProperties?.private?.liaisonSource).toBe("liaison")
    expect(m.pushResults[0]).toMatchObject({ etag: '"new-etag"' })
  })

  it("update: a kept attendee is sent as Google's current object (response, comment, organizer survive); a removed one is dropped; a new one is added", async () => {
    const event = makeEventRow({
      google_event_id: "gevt-1",
      etag: '"stored-etag"',
      pending_push: "update",
      attendees: [
        { email: "dana@acme.example", responseStatus: "needsAction" },
        { email: "new@example.com" },
      ],
      // This edit started from dana + gone: it removed gone and added new.
      attendees_base: [{ email: "dana@acme.example" }, { email: "gone@example.com" }],
    })
    const remoteDana = {
      email: "dana@acme.example",
      displayName: "Dana Girard",
      responseStatus: "accepted",
      organizer: true,
      comment: "Je serai là",
    }
    const m = makeBridge({
      event,
      fetchResponses: (call) =>
        call.method === "GET"
          ? {
              status: 200,
              body: {
                id: "gevt-1",
                etag: '"stored-etag"',
                attendees: [remoteDana, { email: "gone@example.com", responseStatus: "accepted" }],
              },
            }
          : {
              status: 200,
              body: { id: "gevt-1", etag: '"e2"', updated: "2026-07-06T01:00:00.000Z" },
            },
    })
    await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
    const put = m.fetches.find((f) => f.method === "PUT")!
    expect((put.body as { attendees?: unknown }).attendees).toEqual([
      remoteDana,
      { email: "new@example.com" },
    ])
  })

  it("update: an event with no local attendee list keeps Google's attendees as they are", async () => {
    const event = makeEventRow({
      google_event_id: "gevt-1",
      pending_push: "update",
      attendees: null,
    })
    const remoteAttendees = [{ email: "dana@acme.example", responseStatus: "accepted" }]
    const m = makeBridge({
      event,
      fetchResponses: (call) =>
        call.method === "GET"
          ? { status: 200, body: { id: "gevt-1", etag: '"e"', attendees: remoteAttendees } }
          : {
              status: 200,
              body: { id: "gevt-1", etag: '"e2"', updated: "2026-07-06T01:00:00.000Z" },
            },
    })
    await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
    const put = m.fetches.find((f) => f.method === "PUT")!
    expect((put.body as { attendees?: unknown }).attendees).toEqual(remoteAttendees)
  })

  // Reviewer 2026-10-05: a synced row always carries its last-synced attendees; pushing that
  // list as authoritative made a title-only edit drop a guest added on Google since the last
  // inbound sync (or re-invite one removed there).
  describe("attendees: 3-way merge against Google's current list", () => {
    function remoteWith(attendees: unknown[]) {
      return (call: FetchCall) =>
        call.method === "GET"
          ? { status: 200, body: { id: "gevt-1", etag: '"e"', attendees } }
          : {
              status: 200,
              body: { id: "gevt-1", etag: '"e2"', updated: "2026-10-05T10:00:00.000Z", attendees },
            }
    }

    it("a title-only edit keeps a guest added on Google since the last sync", async () => {
      const remote = [
        { email: "a@example.com", responseStatus: "accepted" },
        { email: "added-on-google@example.com", responseStatus: "needsAction" },
      ]
      const m = makeBridge({
        event: makeEventRow({
          google_event_id: "gevt-1",
          pending_push: "update",
          title: "Renamed",
          attendees: [{ email: "a@example.com", responseStatus: "needsAction" }],
          attendees_base: null,
        }),
        fetchResponses: remoteWith(remote),
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      const put = m.fetches.find((f) => f.method === "PUT")!
      expect((put.body as { attendees?: unknown }).attendees).toEqual(remote)
    })

    it("a title-only edit does not re-invite a guest removed on Google", async () => {
      const remote = [{ email: "a@example.com" }]
      const m = makeBridge({
        event: makeEventRow({
          google_event_id: "gevt-1",
          pending_push: "update",
          attendees: [{ email: "a@example.com" }, { email: "removed-on-google@example.com" }],
          attendees_base: null,
        }),
        fetchResponses: remoteWith(remote),
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      const put = m.fetches.find((f) => f.method === "PUT")!
      expect((put.body as { attendees?: unknown }).attendees).toEqual(remote)
    })

    it("a local add and remove apply on top of Google's current list", async () => {
      const m = makeBridge({
        event: makeEventRow({
          google_event_id: "gevt-1",
          pending_push: "update",
          // Started from a + b; removed b, added c.
          attendees: [{ email: "a@example.com" }, { email: "c@example.com" }],
          attendees_base: [{ email: "a@example.com" }, { email: "b@example.com" }],
        }),
        // Google meanwhile gained d.
        fetchResponses: remoteWith([
          { email: "a@example.com", responseStatus: "accepted" },
          { email: "b@example.com" },
          { email: "d@example.com" },
        ]),
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      const put = m.fetches.find((f) => f.method === "PUT")!
      expect((put.body as { attendees?: unknown }).attendees).toEqual([
        { email: "a@example.com", responseStatus: "accepted" },
        { email: "d@example.com" },
        { email: "c@example.com" },
      ])
    })

    it("a successful PUT hands Google's stored resource back so the row shows what Google kept", async () => {
      const kept = [{ email: "a@example.com", responseStatus: "accepted" }]
      const m = makeBridge({
        event: makeEventRow({
          google_event_id: "gevt-1",
          pending_push: "update",
          attendees: [{ email: "a@example.com" }, { email: "c@example.com" }],
          attendees_base: [{ email: "a@example.com" }],
        }),
        fetchResponses: (call) =>
          call.method === "GET"
            ? { status: 200, body: { id: "gevt-1", etag: '"e"', attendees: kept } }
            : {
                status: 200,
                // Google ignored the added guest (not the organizer).
                body: {
                  id: "gevt-1",
                  etag: '"e2"',
                  updated: "2026-10-05T10:00:00.000Z",
                  attendees: kept,
                },
              },
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect((m.pushResults[0] as { remote?: { attendees?: unknown } }).remote?.attendees).toEqual(
        kept,
      )
    })

    it("a 403 on update reverts the row to Google's version instead of leaving it pending", async () => {
      const remote = {
        id: "gevt-1",
        etag: '"e"',
        summary: "Google title",
        attendees: [{ email: "a@example.com" }],
      }
      const m = makeBridge({
        event: makeEventRow({ google_event_id: "gevt-1", pending_push: "update", title: "Local" }),
        fetchResponses: (call) =>
          call.method === "GET"
            ? { status: 200, body: remote }
            : {
                status: 403,
                body: {
                  error: {
                    code: 403,
                    errors: [{ domain: "calendar", reason: "forbiddenForNonOrganizer" }],
                  },
                },
              },
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect(m.reverts).toHaveLength(1)
      expect(m.reverts[0]!.remote).toMatchObject({
        summary: "Google title",
        attendees: remote.attendees,
      })
      expect(m.pushFailures).toEqual([])
    })

    it("a 412 hands the conflict Google's attendees and recurrence", async () => {
      const remote = {
        id: "gevt-1",
        etag: '"e"',
        updated: "2026-10-05T10:00:00.000Z",
        attendees: [{ email: "a@example.com", responseStatus: "accepted" }],
        recurrence: ["RRULE:FREQ=WEEKLY"],
      }
      const m = makeBridge({
        event: makeEventRow({ google_event_id: "gevt-1", pending_push: "update" }),
        conflictOutcome: "remote-won",
        fetchResponses: (call) =>
          call.method === "GET" ? { status: 200, body: remote } : { status: 412, body: {} },
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      const snap = (m.conflictCalls[0] as { remoteSnapshot: Record<string, unknown> })
        .remoteSnapshot
      expect(snap.attendees).toEqual(remote.attendees)
      expect(snap.recurrence).toEqual(remote.recurrence)
    })
  })

  // Reviewer 2026-10-05: every 403 reverted the row to Google's version, but Google answers 403
  // for rate and quota limits too. Real Google error bodies for each class.
  describe("push failures: which 403 reverts, which retries", () => {
    function googleError(code: number, reason: string, message: string, domain = "global") {
      return { error: { errors: [{ domain, reason, message }], code, message } }
    }
    const remote = { id: "gevt-1", etag: '"e"', summary: "Google title" }

    async function pushWithPutResponse(
      status: number,
      body: unknown,
      priorAttempts?: number | null,
      failingForMs?: number,
    ) {
      const m = makeBridge({
        event: makeEventRow({ google_event_id: "gevt-1", pending_push: "update", title: "Local" }),
        fetchResponses: (call) =>
          call.method === "GET" ? { status: 200, body: remote } : { status, body },
        priorAttempts,
        failingForMs,
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      return m
    }

    for (const [reason, domain] of [
      ["rateLimitExceeded", "usageLimits"],
      ["userRateLimitExceeded", "usageLimits"],
      ["quotaExceeded", "usageLimits"],
    ] as const) {
      it(`403 ${reason} keeps the edit and re-queues the push with a delay`, async () => {
        const m = await pushWithPutResponse(
          403,
          googleError(403, reason, "Rate Limit Exceeded", domain),
        )
        expect(m.reverts).toEqual([])
        expect(m.pushFailures[0]).toMatchObject({ errorKind: "RateLimited" })
        expect(m.enqueued).toEqual([
          {
            jobName: "calendar-push",
            payload: { eventId: "evt-local-1" },
            opts: { delay: 60_000, jobId: "calendar-push:evt-local-1:v1:a1" },
          },
        ])
      })
    }

    for (const reason of ["forbiddenForNonOrganizer", "requiredAccessLevel", "forbidden"]) {
      it(`403 ${reason} is a refusal: the row takes Google's version`, async () => {
        const m = await pushWithPutResponse(
          403,
          googleError(
            403,
            reason,
            "Shared properties can only be changed by the organizer of the event.",
            "calendar",
          ),
        )
        expect(m.reverts).toHaveLength(1)
        expect(m.enqueued).toEqual([])
      })
    }

    it("a 403 with an unidentified reason keeps the edit and retries", async () => {
      const m = await pushWithPutResponse(403, googleError(403, "somethingNew", "Nope"))
      expect(m.reverts).toEqual([])
      expect(m.enqueued).toHaveLength(1)
    })

    it("a 5xx retries with a growing delay, and stops re-queueing past the bound", async () => {
      const m = await pushWithPutResponse(503, googleError(503, "backendError", "Backend Error"), 3)
      expect(m.enqueued[0]).toMatchObject({
        opts: { delay: 8 * 60_000, jobId: "calendar-push:evt-local-1:v1:a4" },
      })
      // Past an 8-minute delay the 30-minute sweep takes over: no re-queue, not refused.
      const swept = await pushWithPutResponse(
        503,
        googleError(503, "backendError", "Backend Error"),
        20,
        6 * 60 * 60 * 1000,
      )
      expect(swept.enqueued).toEqual([])
      expect(swept.rejections).toEqual([])
      // Giving up is time-based: only after 24 hours of failing is the change marked refused.
      const capped = await pushWithPutResponse(
        503,
        googleError(503, "backendError", "Backend Error"),
        40,
        25 * 60 * 60 * 1000,
      )
      expect(capped.enqueued).toEqual([])
      expect(capped.rejections).toEqual([
        {
          eventId: "evt-local-1",
          message: "Not accepted by Google after 41 attempts over 24 hours: Backend Error",
        },
      ])
    })

    it("a 400 is not retried", async () => {
      const m = await pushWithPutResponse(
        400,
        googleError(400, "invalid", "Invalid attendee email."),
      )
      expect(m.enqueued).toEqual([])
      expect(m.pushFailures).toHaveLength(1)
    })

    // Coordinator 2026-10-05: a 404/410/400 must not stay pending and be swept forever.
    it("404 on the update: the event was deleted on Google, so it is deleted locally", async () => {
      const m = await pushWithPutResponse(404, googleError(404, "notFound", "Not Found"))
      expect(m.deletions).toEqual(["evt-local-1"])
      expect(m.enqueued).toEqual([])
      expect(m.rejections).toEqual([])
      expect(m.pushFailures[0]).toMatchObject({ errorKind: "Gone" })
    })

    it("410 on the read before the update: deleted locally too", async () => {
      const m = makeBridge({
        event: makeEventRow({ google_event_id: "gevt-1", pending_push: "update" }),
        fetchResponses: () => ({
          status: 410,
          body: googleError(410, "deleted", "Resource has been deleted"),
        }),
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect(m.deletions).toEqual(["evt-local-1"])
      expect(m.enqueued).toEqual([])
    })

    it("400 on the update: no retry, the row records Google's message", async () => {
      const m = await pushWithPutResponse(
        400,
        googleError(400, "invalid", "Invalid attendee email."),
      )
      expect(m.enqueued).toEqual([])
      expect(m.deletions).toEqual([])
      expect(m.rejections).toEqual([{ eventId: "evt-local-1", message: "Invalid attendee email." }])
      expect(m.pushFailures[0]).toMatchObject({ errorKind: "Rejected" })
    })

    it("400 on a create: no retry, the row records Google's message", async () => {
      const m = makeBridge({
        event: makeEventRow(),
        fetchResponses: () => ({
          status: 400,
          body: googleError(400, "timeRangeEmpty", "The specified time range is empty."),
        }),
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect(m.rejections).toEqual([
        { eventId: "evt-local-1", message: "The specified time range is empty." },
      ])
      expect(m.enqueued).toEqual([])
    })

    it("a failed read before the update (403) is retried, not reverted", async () => {
      const m = makeBridge({
        event: makeEventRow({ google_event_id: "gevt-1", pending_push: "update" }),
        fetchResponses: () => ({ status: 403, body: googleError(403, "forbidden", "Forbidden") }),
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect(m.reverts).toEqual([])
      expect(m.enqueued).toHaveLength(1)
    })

    it("a push result names the version the push was read from", async () => {
      const m = makeBridge({
        event: makeEventRow({
          google_event_id: "gevt-1",
          pending_push: "update",
          liaison_sync_version: 7,
        }),
        fetchResponses: (call) =>
          call.method === "GET"
            ? { status: 200, body: remote }
            : {
                status: 200,
                body: { id: "gevt-1", etag: '"e2"', updated: "2026-10-05T10:00:00.000Z" },
              },
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect(m.pushResults[0]).toMatchObject({ syncVersion: 7 })
    })

    // Re-review 2026-10-05 B1: an insert whose answer was lost (Google committed, our fetch saw
    // a 503) was inserted again by the retry: a duplicate event on Google.
    it("a create sends a deterministic Google id: the row uuid without dashes", async () => {
      const m = makeBridge({
        event: makeEventRow({ id: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c" }),
        fetchResponses: () => ({
          status: 200,
          body: {
            id: "0f9e8d7c6b5a4f3e9d2c1b0a9f8e7d6c",
            etag: '"e"',
            updated: "2026-10-05T10:00:00.000Z",
          },
        }),
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c" })
      const insert = m.fetches[0]!
      expect((insert.body as { id?: string }).id).toBe("0f9e8d7c6b5a4f3e9d2c1b0a9f8e7d6c")
      expect((insert.body as { id: string }).id).toMatch(/^[0-9a-v]{5,1024}$/)
    })

    it("a create answered 409 (already committed) adopts Google's event instead of inserting twice", async () => {
      const existing = {
        id: "0f9e8d7c6b5a4f3e9d2c1b0a9f8e7d6c",
        etag: '"committed"',
        updated: "2026-10-05T10:00:00.000Z",
        status: "confirmed",
        attendees: [{ email: "a@example.com", responseStatus: "needsAction" }],
      }
      const m = makeBridge({
        event: makeEventRow({ id: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c" }),
        fetchResponses: (call) =>
          call.method === "POST"
            ? {
                status: 409,
                body: googleError(409, "duplicate", "The requested identifier already exists."),
              }
            : { status: 200, body: existing },
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c" })
      expect(m.fetches.map((f) => f.method)).toEqual(["POST", "GET"])
      expect(m.fetches[1]!.url).toContain("/events/0f9e8d7c6b5a4f3e9d2c1b0a9f8e7d6c")
      expect(m.pushResults[0]).toMatchObject({
        googleEventId: existing.id,
        etag: '"committed"',
        syncVersion: 1,
      })
      expect(m.pushFailures).toEqual([])
      expect(m.enqueued).toEqual([])
    })

    it("a create answered 409 whose event was since deleted on Google is deleted locally", async () => {
      const m = makeBridge({
        event: makeEventRow(),
        fetchResponses: (call) =>
          call.method === "POST"
            ? { status: 409, body: googleError(409, "duplicate", "exists") }
            : {
                status: 200,
                body: {
                  id: "x",
                  etag: '"e"',
                  updated: "2026-10-05T10:00:00.000Z",
                  status: "cancelled",
                },
              },
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect(m.deletions).toEqual(["evt-local-1"])
      expect(m.pushResults).toEqual([])
    })

    // N1: a refusal on a create can never be accepted: no retry loop.
    it("a create refused for permission is marked refused, not retried", async () => {
      const m = makeBridge({
        event: makeEventRow(),
        fetchResponses: () => ({
          status: 403,
          body: googleError(
            403,
            "requiredAccessLevel",
            "You need to have writer access to this calendar.",
            "calendar",
          ),
        }),
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect(m.enqueued).toEqual([])
      expect(m.rejections).toEqual([
        { eventId: "evt-local-1", message: "You need to have writer access to this calendar." },
      ])
    })

    it("a failure on a row edited since the push read it neither retries nor marks it", async () => {
      const m = await pushWithPutResponse(
        503,
        googleError(503, "backendError", "Backend Error"),
        null,
      )
      expect(m.enqueued).toEqual([])
      expect(m.rejections).toEqual([])
    })

    // N2: a 401 must never drop the edit.
    it("a 401 keeps the edit and retries once; a second 401 flags the account for reconnection", async () => {
      const first = await pushWithPutResponse(
        401,
        googleError(401, "authError", "Invalid Credentials"),
      )
      expect(first.rejections).toEqual([])
      expect(first.deletions).toEqual([])
      expect(first.pushFailures[0]).toMatchObject({ errorKind: "Unauthorized" })
      expect(first.enqueued).toEqual([
        {
          jobName: "calendar-push",
          payload: { eventId: "evt-local-1", authRetry: true },
          opts: { delay: 60_000, jobId: "calendar-push:evt-local-1:v1:auth" },
        },
      ])

      const second = makeBridge({
        event: makeEventRow({ google_event_id: "gevt-1", pending_push: "update" }),
        fetchResponses: (call) =>
          call.method === "GET"
            ? { status: 200, body: remote }
            : { status: 401, body: googleError(401, "authError", "Invalid Credentials") },
      })
      await runPush(second.bridge, { orgId: "org-1", eventId: "evt-local-1", authRetry: true })
      expect(second.pushFailures[0]).toMatchObject({ errorKind: "AuthRevoked" })
      expect(second.rejections).toEqual([])
      expect(second.enqueued).toEqual([])
    })

    // N4: every terminal outcome is conditioned on the version the push read.
    it("deletion, refusal and revert are conditioned on the row version the push read", async () => {
      const event = { google_event_id: "gevt-1", pending_push: "update", liaison_sync_version: 5 }
      const gone = makeBridge({
        event: makeEventRow(event),
        fetchResponses: (call) =>
          call.method === "GET"
            ? { status: 200, body: remote }
            : { status: 404, body: googleError(404, "notFound", "Not Found") },
      })
      await runPush(gone.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      const bad = makeBridge({
        event: makeEventRow(event),
        fetchResponses: (call) =>
          call.method === "GET"
            ? { status: 200, body: remote }
            : { status: 400, body: googleError(400, "invalid", "Invalid") },
      })
      await runPush(bad.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      const refused = makeBridge({
        event: makeEventRow(event),
        fetchResponses: (call) =>
          call.method === "GET"
            ? { status: 200, body: remote }
            : { status: 403, body: googleError(403, "forbiddenForNonOrganizer", "No", "calendar") },
      })
      await runPush(refused.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect([...gone.versions, ...bad.versions, ...refused.versions]).toEqual([
        { call: "delete", syncVersion: 5 },
        { call: "reject", syncVersion: 5 },
        { call: "revert", syncVersion: 5 },
      ])
    })

    it("a create whose row was deleted while it was in flight is deleted on Google", async () => {
      const m = makeBridge({
        event: makeEventRow({ id: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c" }),
        fetchResponses: (call) =>
          call.method === "POST"
            ? {
                status: 200,
                body: {
                  id: "0f9e8d7c6b5a4f3e9d2c1b0a9f8e7d6c",
                  etag: '"e"',
                  updated: "2026-10-05T10:00:00.000Z",
                },
              }
            : { status: 204, body: "" },
      })
      m.bridge.calendar_applyPushResult = async () => JSON.stringify({ rowExists: false })
      await runPush(m.bridge, { orgId: "org-1", eventId: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c" })
      expect(m.fetches.map((f) => f.method)).toEqual(["POST", "DELETE"])
      expect(m.fetches[1]!.url).toContain(
        "/events/0f9e8d7c6b5a4f3e9d2c1b0a9f8e7d6c?sendUpdates=none",
      )
    })

    it("a network error (fetch throws) counts as an attempt and is retried like a 5xx", async () => {
      const m = makeBridge({
        event: makeEventRow({ google_event_id: "gevt-1", pending_push: "update" }),
        fetchResponses: () => ({ status: 200, body: remote }),
      })
      m.bridge.fetch = async () => {
        throw new Error("ECONNRESET")
      }
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect(m.pushFailures).toHaveLength(1)
      expect(m.enqueued).toEqual([
        {
          jobName: "calendar-push",
          payload: { eventId: "evt-local-1" },
          opts: { delay: 60_000, jobId: "calendar-push:evt-local-1:v1:a1" },
        },
      ])
    })

    describe("a local delete (tombstone) pushed to Google", () => {
      const tombstone = {
        google_event_id: "gevt-1",
        pending_push: "delete",
        liaison_sync_version: 4,
      }

      for (const status of [204, 404, 410]) {
        it(`${status}: the tombstone goes`, async () => {
          const m = makeBridge({
            event: makeEventRow(tombstone),
            fetchResponses: () => ({ status, body: "" }),
          })
          await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
          expect(m.fetches.map((f) => f.method)).toEqual(["DELETE"])
          expect(m.fetches[0]!.url).toContain("/events/gevt-1?sendUpdates=none")
          expect(m.finalizedDeletes).toEqual(["evt-local-1"])
        })
      }

      for (const [status, body] of [
        [503, googleError(503, "backendError", "Backend Error")],
        [429, googleError(429, "rateLimitExceeded", "Rate Limit Exceeded")],
        [403, googleError(403, "userRateLimitExceeded", "User Rate Limit Exceeded", "usageLimits")],
      ] as const) {
        it(`${status} ${(body as any).error.errors[0].reason}: kept and retried with backoff`, async () => {
          const m = makeBridge({
            event: makeEventRow(tombstone),
            fetchResponses: () => ({ status, body }),
          })
          await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
          expect(m.fetches.map((f) => f.method)).toEqual(["DELETE"])
          expect(m.finalizedDeletes).toEqual([])
          expect(m.rejections).toEqual([])
          expect(m.enqueued).toEqual([
            {
              jobName: "calendar-push",
              payload: { eventId: "evt-local-1" },
              opts: { delay: 60_000, jobId: "calendar-push:evt-local-1:v4:a1" },
            },
          ])
        })
      }

      it("a network error is kept and retried", async () => {
        const m = makeBridge({
          event: makeEventRow(tombstone),
          fetchResponses: () => ({ status: 200 }),
        })
        const methods: string[] = []
        m.bridge.fetch = async (_url: string, optsJson: string) => {
          methods.push(JSON.parse(optsJson).method)
          throw new Error("ETIMEDOUT")
        }
        await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
        expect(methods).toEqual(["DELETE"])
        expect(m.finalizedDeletes).toEqual([])
        expect(m.enqueued).toHaveLength(1)
      })

      it("a permission refusal brings the event back, refreshed from Google, with the refusal (no retry)", async () => {
        const current = {
          id: "gevt-1",
          etag: '"now"',
          summary: "Renamed on Google",
          status: "confirmed",
        }
        const m = makeBridge({
          event: makeEventRow(tombstone),
          fetchResponses: (call) =>
            call.method === "DELETE"
              ? {
                  status: 403,
                  body: googleError(
                    403,
                    "requiredAccessLevel",
                    "You need to have writer access to this calendar.",
                    "calendar",
                  ),
                }
              : { status: 200, body: current },
        })
        await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
        expect(m.fetches.map((f) => f.method)).toEqual(["DELETE", "GET"])
        expect(m.enqueued).toEqual([])
        expect(m.restores).toEqual([
          {
            eventId: "evt-local-1",
            message: "deleting this event: You need to have writer access to this calendar.",
            syncVersion: 4,
            remote: current,
          },
        ])
      })

      it("a refused delete that had superseded a local edit pushes that edit again", async () => {
        const m = makeBridge({
          event: makeEventRow(tombstone),
          fetchResponses: (call) =>
            call.method === "DELETE"
              ? { status: 400, body: googleError(400, "invalid", "Invalid") }
              : { status: 200, body: { id: "gevt-1", etag: '"e"' } },
          pendingRestored: true,
        })
        await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
        expect(m.enqueued).toHaveLength(1)
        expect(m.enqueued[0]).toMatchObject({
          jobName: "calendar-push",
          payload: { eventId: "evt-local-1" },
        })
      })

      it("24 hours of failures brings the event back with the refusal", async () => {
        const m = makeBridge({
          event: makeEventRow(tombstone),
          fetchResponses: () => ({
            status: 503,
            body: googleError(503, "backendError", "Backend Error"),
          }),
          priorAttempts: 50,
          failingForMs: 25 * 60 * 60 * 1000,
        })
        await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
        expect(m.restores).toEqual([
          {
            eventId: "evt-local-1",
            message:
              "Not accepted by Google after 51 attempts over 24 hours: deleting this event: Backend Error",
            syncVersion: 4,
            // Google could not be read either: the local values come back as they were.
            remote: null,
          },
        ])
      })
    })

    // Follow-up 2026-10-05: a push that throws before Google answers recorded no attempt, so
    // backoff, the sweep's job id and the 24-hour give-up all stalled.
    it("a push that throws before reaching Google counts an attempt and is retried", async () => {
      const m = makeBridge({
        event: makeEventRow({ google_event_id: "gevt-1", pending_push: "update" }),
        fetchResponses: () => ({ status: 200, body: {} }),
      })
      m.bridge.connections_getToken = async () => {
        throw new Error("token refresh failed")
      }
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect(m.fetches).toEqual([])
      expect(m.pushFailures).toHaveLength(1)
      expect(m.enqueued).toEqual([
        {
          jobName: "calendar-push",
          payload: { eventId: "evt-local-1" },
          opts: { delay: 60_000, jobId: "calendar-push:evt-local-1:v1:a1" },
        },
      ])
    })

    it("the periodic poll re-queues local edits still waiting for Google", async () => {
      const enqueued: Array<{ jobName: string; payload: any; opts?: any }> = []
      await runCalendar({
        exportName: "calendarPollFallback",
        params: {},
        bridge: {
          calendar_findCalendarsForPollFallback: async () => "[]",
          calendar_markCalendarPolled: async () => {},
          calendar_findStalePendingPushes: async () =>
            JSON.stringify([
              { id: "evt-a", liaison_sync_version: 3, push_attempts: 2 },
              { id: "evt-b", liaison_sync_version: 1, push_attempts: 0 },
            ]),
          enqueueJob: async (jobName: string, payloadJson: string, optsJson?: string) => {
            enqueued.push({
              jobName,
              payload: JSON.parse(payloadJson),
              ...(optsJson ? { opts: JSON.parse(optsJson) } : {}),
            })
          },
          log_info: () => {},
          log_warn: () => {},
          log_error: () => {},
        } as never,
        timeoutMs: 15000,
      })
      // Same job id as the retry already queued for that version and attempt, so the sweep
      // never starts a second concurrent push of the same row.
      // One job id per row, version, attempt AND sweep run: a retained failed job with an old
      // id cannot block a later sweep.
      expect(enqueued.map((e) => e.payload)).toEqual([{ eventId: "evt-a" }, { eventId: "evt-b" }])
      expect(enqueued[0]!.opts.jobId).toMatch(/^calendar-push:evt-a:v3:a2:sweep\d+$/)
      expect(enqueued[1]!.opts.jobId).toMatch(/^calendar-push:evt-b:v1:a0:sweep\d+$/)
    })
  })

  it("update 412 on all 3 attempts -> recordPushFailure once (EtagMismatch), no 4th PUT", async () => {
    const event = makeEventRow({
      google_event_id: "gevt-1",
      etag: '"stored-etag"',
      pending_push: "update",
    })
    const m = makeBridge({
      event,
      conflictOutcome: "retry",
      currentEvent: () => event, // version never advances -> retry path
      fetchResponses: (call) => {
        if (call.method === "GET") {
          return {
            status: 200,
            body: { id: "gevt-1", etag: '"remote-etag"', updated: "2020-01-01T00:00:00Z" },
          }
        }
        return { status: 412, body: {} } // every PUT conflicts
      },
    })
    await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })

    const puts = m.fetches.filter((f) => f.method === "PUT")
    // 3 attempts total (initial + 2 retries), then exhaustion — never a 4th.
    expect(puts).toHaveLength(3)
    expect(m.pushFailures).toHaveLength(1)
    expect(m.pushFailures[0]!.errorKind).toBe("EtagMismatch")
    expect(m.pushFailures[0]!.detail).not.toContain("Bearer")
  })

  it("delete: DELETEs with sendUpdates=none and If-Match when an etag is present", async () => {
    const m = makeBridge({
      event: makeEventRow(),
      fetchResponses: () => ({ status: 204, body: {} }),
    })
    await runPush(m.bridge, {
      orgId: "org-1",
      deleted: true,
      googleEventId: "gevt-del",
      etag: '"del-etag"',
      calendarId: "cal-1",
    })
    expect(m.fetches).toHaveLength(1)
    const del = m.fetches[0]!
    expect(del.method).toBe("DELETE")
    expect(del.url).toContain("sendUpdates=none")
    expect(del.headers["If-Match"]).toBe('"del-etag"')
  })

  it("deleting one occurrence DELETEs Google's instance id, not the series", async () => {
    const m = makeBridge({
      event: makeEventRow({
        google_event_id: "gmaster_20260713T090000Z",
        pending_push: "delete",
      }),
      fetchResponses: () => ({ status: 204, body: {} }),
    })
    await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
    const del = m.fetches[0]!
    expect(del.method).toBe("DELETE")
    expect(del.url).toContain("/events/gmaster_20260713T090000Z?sendUpdates=none")
    expect(m.finalizedDeletes).toEqual(["evt-local-1"])
  })

  it("delete omits the If-Match header entirely when there is no etag", async () => {
    const m = makeBridge({
      event: makeEventRow(),
      fetchResponses: () => ({ status: 204, body: {} }),
    })
    await runPush(m.bridge, {
      orgId: "org-1",
      deleted: true,
      googleEventId: "gevt-del",
      etag: null,
      calendarId: "cal-1",
    })
    const del = m.fetches[0]!
    expect("If-Match" in del.headers).toBe(false)
  })

  it("an edited occurrence of a recurring meeting is written to Google's instance, not the series", async () => {
    const m = makeBridge({
      event: makeEventRow({
        google_event_id: "gmaster_20260713T090000Z",
        etag: null,
        pending_push: "update",
        start: { dateTime: "2026-07-13T11:00:00Z" },
        end: { dateTime: "2026-07-13T11:30:00Z" },
      }),
      fetchResponses: (call) =>
        call.method === "GET"
          ? {
              status: 200,
              body: {
                id: "gmaster_20260713T090000Z",
                etag: '"inst"',
                recurringEventId: "gmaster",
                originalStartTime: { dateTime: "2026-07-13T09:00:00Z" },
                start: { dateTime: "2026-07-13T09:00:00Z" },
                end: { dateTime: "2026-07-13T09:30:00Z" },
              },
            }
          : {
              status: 200,
              body: {
                id: "gmaster_20260713T090000Z",
                etag: '"n"',
                updated: "2026-07-06T01:00:00Z",
              },
            },
    })
    await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
    const put = m.fetches[1]!
    expect(put.method).toBe("PUT")
    expect(put.url).toContain("/events/gmaster_20260713T090000Z?")
    const body = put.body as Record<string, unknown>
    expect(body.recurringEventId).toBe("gmaster")
    expect(body.originalStartTime).toEqual({ dateTime: "2026-07-13T09:00:00Z" })
    expect(body.start).toEqual({ dateTime: "2026-07-13T11:00:00Z" })
    expect(body.recurrence).toBeUndefined()
  })

  describe("Google Meet conferencing", () => {
    const MEET = "https://meet.google.com/abc-defg-hij"
    const meetConference = {
      conferenceId: "abc-defg-hij",
      conferenceSolution: { key: { type: "hangoutsMeet" } },
      entryPoints: [{ entryPointType: "video", uri: MEET }],
    }

    it("create with a Meet request: events.insert carries conferenceData.createRequest (hangoutsMeet, requestId) with conferenceDataVersion=1, and the link Google returns is stored", async () => {
      const m = makeBridge({
        event: makeEventRow({ conference_request: "add" }),
        fetchResponses: () => ({
          status: 200,
          body: {
            id: "gevt-meet",
            etag: '"etag-meet"',
            updated: "2026-07-06T00:00:00.000Z",
            hangoutLink: MEET,
            conferenceData: meetConference,
          },
        }),
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })

      const insert = m.fetches[0]!
      expect(insert.method).toBe("POST")
      expect(insert.url).toContain("sendUpdates=none")
      expect(insert.url).toContain("conferenceDataVersion=1")
      const body = insert.body as {
        location?: string
        conferenceData?: {
          createRequest?: { requestId?: string; conferenceSolutionKey?: { type?: string } }
        }
      }
      expect(body.conferenceData?.createRequest?.conferenceSolutionKey?.type).toBe("hangoutsMeet")
      expect(typeof body.conferenceData?.createRequest?.requestId).toBe("string")
      expect(body.conferenceData?.createRequest?.requestId?.length).toBeGreaterThan(8)
      // Never a product name standing in for the link.
      expect(body.location).toBeUndefined()
      expect(m.pushResults[0]).toMatchObject({ googleEventId: "gevt-meet", hangoutLink: MEET })
    })

    it("create without a Meet request sends no conferenceData and no conferenceDataVersion", async () => {
      const m = makeBridge({
        event: makeEventRow(),
        fetchResponses: () => ({
          status: 200,
          body: { id: "gevt-plain", etag: '"e"', updated: "2026-07-06T00:00:00.000Z" },
        }),
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      expect(m.fetches[0]!.url).not.toContain("conferenceDataVersion")
      expect((m.fetches[0]!.body as Record<string, unknown>).conferenceData).toBeUndefined()
    })

    it("update adding a Meet to an existing event: the PUT carries a createRequest with conferenceDataVersion=1 and the new link is stored", async () => {
      const m = makeBridge({
        event: makeEventRow({
          google_event_id: "gevt-1",
          etag: '"stored-etag"',
          pending_push: "update",
          conference_request: "add",
        }),
        fetchResponses: (call) =>
          call.method === "GET"
            ? { status: 200, body: { id: "gevt-1", etag: '"stored-etag"', summary: "Standup" } }
            : {
                status: 200,
                body: {
                  id: "gevt-1",
                  etag: '"new-etag"',
                  updated: "2026-07-06T01:00:00.000Z",
                  hangoutLink: MEET,
                  conferenceData: meetConference,
                },
              },
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      const put = m.fetches[1]!
      expect(put.method).toBe("PUT")
      expect(put.url).toContain("conferenceDataVersion=1")
      const body = put.body as {
        conferenceData?: { createRequest?: { conferenceSolutionKey?: { type?: string } } }
      }
      expect(body.conferenceData?.createRequest?.conferenceSolutionKey?.type).toBe("hangoutsMeet")
      expect(m.pushResults[0]).toMatchObject({ hangoutLink: MEET })
    })

    it("update asking for a Meet on an event that already has one keeps the existing conference (no second createRequest)", async () => {
      const m = makeBridge({
        event: makeEventRow({
          google_event_id: "gevt-1",
          etag: '"stored-etag"',
          pending_push: "update",
          conference_request: "add",
        }),
        fetchResponses: (call) =>
          call.method === "GET"
            ? {
                status: 200,
                body: {
                  id: "gevt-1",
                  etag: '"stored-etag"',
                  hangoutLink: MEET,
                  conferenceData: meetConference,
                },
              }
            : { status: 200, body: { id: "gevt-1", etag: '"n"', updated: "2026-07-06T01:00:00Z" } },
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      const body = m.fetches[1]!.body as { conferenceData?: Record<string, unknown> }
      expect(body.conferenceData).toEqual(meetConference)
    })

    it("update removing the Meet: the PUT sets conferenceData to null with conferenceDataVersion=1", async () => {
      const m = makeBridge({
        event: makeEventRow({
          google_event_id: "gevt-1",
          etag: '"stored-etag"',
          pending_push: "update",
          conference_request: "remove",
        }),
        fetchResponses: (call) =>
          call.method === "GET"
            ? {
                status: 200,
                body: {
                  id: "gevt-1",
                  etag: '"stored-etag"',
                  hangoutLink: MEET,
                  conferenceData: meetConference,
                },
              }
            : { status: 200, body: { id: "gevt-1", etag: '"n"', updated: "2026-07-06T01:00:00Z" } },
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      const put = m.fetches[1]!
      expect(put.url).toContain("conferenceDataVersion=1")
      const body = put.body as Record<string, unknown>
      expect(body.conferenceData).toBeNull()
      expect(body.hangoutLink).toBeUndefined()
      expect(m.pushResults[0]).toMatchObject({ hangoutLink: null })
    })

    it("update of time and attendees reaches Google: the PUT carries the new start/end and the added guest", async () => {
      const m = makeBridge({
        event: makeEventRow({
          google_event_id: "gevt-1",
          etag: '"stored-etag"',
          pending_push: "update",
          start: { dateTime: "2026-07-06T11:00:00Z" },
          end: { dateTime: "2026-07-06T11:30:00Z" },
          attendees: [{ email: "a@acme.example" }, { email: "b@acme.example" }],
          attendees_base: [{ email: "a@acme.example" }],
        }),
        fetchResponses: (call) =>
          call.method === "GET"
            ? {
                status: 200,
                body: {
                  id: "gevt-1",
                  etag: '"stored-etag"',
                  start: { dateTime: "2026-07-06T09:00:00Z" },
                  end: { dateTime: "2026-07-06T09:30:00Z" },
                  attendees: [{ email: "a@acme.example", responseStatus: "accepted" }],
                },
              }
            : { status: 200, body: { id: "gevt-1", etag: '"n"', updated: "2026-07-06T01:00:00Z" } },
      })
      await runPush(m.bridge, { orgId: "org-1", eventId: "evt-local-1" })
      const put = m.fetches[1]!
      // No conference change: Google's conference is left alone (no conferenceDataVersion).
      expect(put.url).not.toContain("conferenceDataVersion")
      const body = put.body as {
        start?: unknown
        end?: unknown
        attendees?: Array<{ email: string }>
      }
      expect(body.start).toEqual({ dateTime: "2026-07-06T11:00:00Z" })
      expect(body.end).toEqual({ dateTime: "2026-07-06T11:30:00Z" })
      expect(body.attendees?.map((a) => a.email).sort()).toEqual([
        "a@acme.example",
        "b@acme.example",
      ])
    })

    it("create_event with conference=google_meet pushes right away and returns the Meet link in the tool result", async () => {
      let pushed = false
      const created: unknown[] = []
      const m = makeBridge({
        event: makeEventRow({ conference_request: "add" }),
        currentEvent: () =>
          pushed
            ? makeEventRow({
                google_event_id: "gevt-meet",
                pending_push: "none",
                conference_request: null,
                hangout_link: MEET,
              })
            : makeEventRow({ conference_request: "add" }),
        fetchResponses: () => ({
          status: 200,
          body: {
            id: "gevt-meet",
            etag: '"etag-meet"',
            updated: "2026-07-06T00:00:00.000Z",
            hangoutLink: MEET,
            conferenceData: meetConference,
          },
        }),
      })
      m.bridge.calendar_createEvent = async (paramsJson: string) => {
        created.push(JSON.parse(paramsJson))
        return JSON.stringify({ eventId: "evt-local-1", conference: "add" })
      }
      const baseApply = m.bridge.calendar_applyPushResult
      m.bridge.calendar_applyPushResult = async (id: string, json: string) => {
        pushed = true
        return baseApply(id, json)
      }
      const result = (await runCalendar({
        exportName: "calendarCreateEvent",
        params: {
          calendarId: "cal-1",
          title: "Sync",
          start: "2026-07-06T09:00:00Z",
          end: "2026-07-06T09:30:00Z",
          conference: "google_meet",
        },
        bridge: m.bridge,
        timeoutMs: 15000,
      })) as unknown
      const out = (
        typeof result === "string"
          ? JSON.parse(result)
          : ((result as { result?: unknown }).result ?? result)
      ) as { eventId?: string; meetLink?: string }
      expect((created[0] as { conference?: string }).conference).toBe("google_meet")
      expect(m.fetches[0]!.url).toContain("conferenceDataVersion=1")
      expect(JSON.stringify(out)).toContain(MEET)
    })
  })
})

// Regression (staging 2026-07-03): calendarImport crashed in QuickJS with
// "'URLSearchParams' is not defined" — the import/sync handlers had never been driven
// through the real sandbox (only via mock bridges), so missing sandbox globals shipped.
// These tests run calendarImport and calendarInitialSync through the core module, as runApp does.
describe("calendar import + initial-sync handlers (core module)", () => {
  async function runHandler(
    exportName: string,
    bridge: Record<string, any>,
    payload: unknown,
  ): Promise<void> {
    await runCalendar({
      exportName,
      params: payload,
      bridge: bridge as never,
      timeoutMs: 30_000,
    })
  }

  function fetchOk(body: unknown) {
    return JSON.stringify({ status: 200, headers: {}, body: JSON.stringify(body) })
  }

  it("calendarImport lists calendarList pages and hands entries to the host", async () => {
    const fetchUrls: string[] = []
    let imported: unknown = null
    const bridge: Record<string, any> = {
      calendar_getAccount: async () =>
        JSON.stringify({ id: "acc-1", email_address: "u@example.com" }),
      connections_getToken: async () => "tok",
      fetch: async (url: string) => {
        fetchUrls.push(url)
        if (fetchUrls.length === 1) {
          return fetchOk({ items: [{ id: "cal-a" }], nextPageToken: "p2" })
        }
        return fetchOk({ items: [{ id: "cal-b" }] })
      },
      calendar_importCalendars: async (_accountId: string, entriesJson: string) => {
        imported = JSON.parse(entriesJson)
        return "{}"
      },
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
    }
    await runHandler("calendarImport", bridge, { orgId: "org-1", accountId: "acc-1" })
    expect(fetchUrls).toHaveLength(2)
    expect(fetchUrls[0]).toContain("minAccessRole=reader")
    expect(fetchUrls[1]).toContain("pageToken=p2")
    expect(imported).toEqual([{ id: "cal-a" }, { id: "cal-b" }])
  })

  it("calendarImport records a Google refusal on the account and does not import an empty list", async () => {
    // Production 2026-10-05: Google answered 403 SERVICE_DISABLED (Calendar API off in the
    // Cloud project). The handler logged only {status}, imported [] and the account stayed
    // 'active' with zero calendars and no error.
    const googleBody = JSON.stringify({
      error: {
        code: 403,
        message:
          "Google Calendar API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123 then retry.",
        errors: [{ reason: "accessNotConfigured" }],
        status: "PERMISSION_DENIED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "SERVICE_DISABLED",
            metadata: {
              activationUrl:
                "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123",
            },
          },
        ],
      },
    })
    let imported: unknown = null
    const failures: Array<{ accountId: string; status: number; body: string }> = []
    const errors: string[] = []
    const bridge: Record<string, any> = {
      calendar_getAccount: async () =>
        JSON.stringify({ id: "acc-1", email_address: "u@example.com" }),
      connections_getToken: async () => "tok",
      fetch: async () => JSON.stringify({ status: 403, headers: {}, body: googleBody }),
      calendar_importCalendars: async (_accountId: string, entriesJson: string) => {
        imported = JSON.parse(entriesJson)
        return "{}"
      },
      calendar_recordImportFailure: async (accountId: string, status: number, body: string) => {
        failures.push({ accountId, status, body })
        return JSON.stringify({ reason: "SERVICE_DISABLED", message: "API disabled" })
      },
      log_info: () => {},
      log_warn: () => {},
      log_error: (msg: string, data?: string) => {
        errors.push(`${msg} ${data ?? ""}`)
      },
    }
    await runHandler("calendarImport", bridge, { orgId: "org-1", accountId: "acc-1" })
    expect(imported).toBeNull()
    expect(failures).toEqual([{ accountId: "acc-1", status: 403, body: googleBody }])
    expect(errors.join("\n")).toContain("SERVICE_DISABLED")
  })

  it("calendarInitialSync streams pages one host call each and registers a watch channel", async () => {
    // Multi-page: accumulating all pages in QuickJS OOMs on big calendars (staging 2026-07-03),
    // so the handler must call calendar_applyInitialSyncPages once per fetched page.
    const fetchCalls: Array<{ url: string; body?: string }> = []
    const applyCalls: unknown[][] = []
    let recordedChannel: { channelId: string; resourceId: string; expiration: string } | null = null
    const bridge: Record<string, any> = {
      calendar_getCalendar: async () =>
        JSON.stringify({
          id: "cal-1",
          account_id: "acc-1",
          google_calendar_id: "gcal-1",
          sync_token: null,
          calaccess: "acc-1",
        }),
      calendar_getAccount: async () =>
        JSON.stringify({ id: "acc-1", email_address: "u@example.com" }),
      connections_getToken: async () => "tok",
      config_get: async (key: string) =>
        key === "calendarPushSecret" ? "s3cret" : "https://liaison.example.com/webhooks/x",
      fetch: async (url: string, optsJson: string) => {
        const opts = JSON.parse(optsJson) as { body?: string }
        fetchCalls.push({ url, body: opts.body })
        if (url.includes("/events/watch")) {
          return fetchOk({ resourceId: "res-1", expiration: "1900000000000" })
        }
        if (url.includes("pageToken=ep2")) {
          return fetchOk({ items: [{ id: "evt-2", status: "confirmed" }], nextSyncToken: "st-1" })
        }
        return fetchOk({ items: [{ id: "evt-1", status: "confirmed" }], nextPageToken: "ep2" })
      },
      calendar_applyInitialSyncPages: async (
        _calendarId: string,
        _calaccess: string,
        pagesJson: string,
      ) => {
        applyCalls.push(JSON.parse(pagesJson) as unknown[])
        return "{}"
      },
      calendar_recordWatchChannel: async (_calendarId: string, channelJson: string) => {
        recordedChannel = JSON.parse(channelJson)
        return "{}"
      },
      calendar_channelToken: async (secret: string, channelId: string) =>
        `tok:${secret}:${channelId}`,
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
    }
    await runHandler("calendarInitialSync", bridge, { orgId: "org-1", calendarId: "cal-1" })

    const eventsCall = fetchCalls.find((c) => c.url.includes("/events?"))
    expect(eventsCall).toBeTruthy()
    expect(eventsCall!.url).toContain("singleEvents=false")
    expect(eventsCall!.url).toContain("showDeleted=true")
    // One host apply call PER page, each carrying exactly one page.
    expect(applyCalls).toHaveLength(2)
    expect(applyCalls[0]).toHaveLength(1)
    expect(applyCalls[1]).toHaveLength(1)
    expect(JSON.stringify(applyCalls[1])).toContain("st-1")
    expect(recordedChannel).not.toBeNull()
    expect(recordedChannel!.resourceId).toBe("res-1")
    expect(recordedChannel!.channelId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    const watchCall = fetchCalls.find((c) => c.url.includes("/events/watch"))
    // The channel token is derived per channel, never the org secret itself.
    expect(watchCall!.body).toContain(`"token":"tok:s3cret:${recordedChannel!.channelId}"`)
    expect(watchCall!.body).not.toContain('"token":"s3cret"')
  })
})
