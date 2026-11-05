// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine run that needs its owner's PRIVATE mailbox waits for its owner
// (routine-mailbox-wait.ts): it parks with one Home item, runs only on the
// owner's Run now from their own browser (its nonce), lapses after 24 hours,
// and a routine someone else set up is refused, never parked. A standard
// (managed) mailbox is read server-side and nothing waits.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  attentionEvents,
  auditLog,
  pendingEvents,
  routineRuns,
  routines as routinesTbl,
  users,
} from "~/db/schema/kernel"
import {
  fulfilMailboxMarker,
  MAILBOX_LOCKED,
  MAILBOX_NEEDS_WINDOW,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"
import { resolveMailboxRequest } from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import {
  dismissWaitingMailboxRun,
  expireMailboxWaits,
  MAILBOX_WAIT_SKIP_REASON,
  mailboxWaitEntityId,
  runWaitingMailboxRun,
} from "~/modules/agent/routines/routine-mailbox-wait"
import { type RoutineTickOpts, runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { currentRunContext, type RunContext } from "~/modules/agent/runtime/run-context"
import { kernelTranslations } from "~/modules/attention/kernel-translations"
import { evaluatePredicate } from "~/modules/attention/predicates"
import { createTestOrg } from "~/tests/helpers/org"
import { clearRedisPatterns } from "~/tests/route-test-setup"

const SECRET = "PRIVATEBODY-do-not-leak"
const ACCOUNT = "acct-private-1"

async function makeUser(orgId: string, name: string): Promise<string> {
  return withSystemDb("rmw-user", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId,
        email: `rmw-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name,
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
}

async function makeRoutine(orgId: string, ownerUserId: string, createdByUserId = ownerUserId) {
  const [row] = await withPrivilegedDb(orgId, "rmw-routine", (tx) =>
    tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId,
        name: `Morning mail ${crypto.randomUUID().slice(0, 6)}`,
        description: "Reads my mail",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "summarise my mail",
        scopes: [],
        enabled: true,
        status: "active",
        visibility: "personal",
        createdByUserId,
        createdByActorType: "user",
      })
      .returning(),
  )
  return row
}

function readMarker(messageId = "m1") {
  return {
    needsPlaintext: { requestKind: "mail.read", messageIds: [messageId], purpose: "summarise" },
    envelope: [{ messageId, from: "a@b.c" }],
  }
}

/** A turn that reads one message of the owner's mailbox through the real broker. */
function mailReadingInvoker(opts: {
  managed?: boolean
  seen?: Array<{ frame: RunContext | undefined; status: string; emitted: number }>
  emitted?: Array<Record<string, unknown>>
  /** The owner's browser: it answers only the turn whose nonce it minted. */
  browserNonce?: string
  contexts?: string[]
  /** False: no window of the owner's is open (the browser closed). */
  unlocked?: boolean
  /** A second message the turn reads after the first. */
  alsoRead?: string
  /** Each read's `mailbox` answer, in order. */
  answers?: Array<{ status?: string; reason?: string }>
  /** Awaited before the turn starts (holds the routine lock meanwhile). */
  gate?: Promise<void>
}): NonNullable<RoutineTickOpts["agentInvoker"]> {
  return async (input) => {
    if (opts.gate) await opts.gate
    const frame = currentRunContext()
    const emitted: Array<Record<string, unknown>> = opts.emitted ?? []
    const read = (messageId: string) =>
      fulfilMailboxMarker({
        result: readMarker(messageId),
        orgId: input.orgId,
        userId: input.ownerUserId,
        threadId: input.threadId,
        frame,
        deps: {
          getUnlock: async () =>
            opts.unlocked === false
              ? undefined
              : { unlocked: true, keyIds: [1], expiresAt: Date.now() + 60_000 },
          emit: async (_action, data) => {
            emitted.push(data)
            // The owner's browser answers only a turn it started: nothing else.
            if (opts.browserNonce && data.turnNonce === opts.browserNonce) {
              setTimeout(() => {
                resolveMailboxRequest(String(data.requestId), {
                  userId: input.ownerUserId,
                  turnNonce: String(data.turnNonce),
                  response: {
                    kind: "plaintext",
                    items: [{ messageId: "m1", subject: "Hi", textBody: SECRET }],
                    undecryptable: [],
                  },
                })
              }, 0)
            }
          },
          injectContext: (_runId, block) => {
            opts.contexts?.push(block)
          },
          answerManaged: async () =>
            opts.managed
              ? {
                  kind: "plaintext",
                  items: [{ messageId: "m1", subject: "Hi", textBody: SECRET }],
                  undecryptable: [],
                }
              : null,
          privateMailboxes: async () => (opts.managed ? null : [ACCOUNT]),
        },
      })
    const out = await read("m1")
    const answerOf = (r: unknown) =>
      (r as { mailbox?: { status?: string; reason?: string } }).mailbox ?? {}
    const status = answerOf(out.result).status ?? ""
    opts.answers?.push(answerOf(out.result))
    if (opts.alsoRead) opts.answers?.push(answerOf((await read(opts.alsoRead)).result))
    opts.seen?.push({ frame, status, emitted: emitted.length })
    return { turnsAdded: 1 }
  }
}

describe("routine runs waiting for a private mailbox", () => {
  let orgId: string
  let owner: string
  let admin: string

  beforeAll(async () => {
    orgId = (await createTestOrg()).id
    owner = await makeUser(orgId, "Mailbox Owner")
    admin = await makeUser(orgId, "Org Admin")
  })

  beforeEach(async () => {
    await clearRedisPatterns(["routine-lock:*"])
  })

  afterEach(async () => {
    await withPrivilegedDb(orgId, "rmw-cleanup", async (tx) => {
      await tx.delete(attentionEvents).where(eq(attentionEvents.orgId, orgId))
      await tx.delete(routineRuns).where(eq(routineRuns.orgId, orgId))
      await tx.delete(routinesTbl).where(eq(routinesTbl.orgId, orgId))
    })
  })

  const tick = (routineId: string, extra: Partial<RoutineTickOpts> = {}) =>
    runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      ...extra,
    })

  async function runsOf(routineId: string) {
    return withPrivilegedDb(orgId, "rmw-runs", (tx) =>
      tx.select().from(routineRuns).where(eq(routineRuns.routineId, routineId)),
    )
  }

  /** The approvals items queued for the routine's waiting runs (one per run). */
  async function waitItems(routineId: string) {
    return withSystemDb("rmw-items", (db) =>
      db
        .select({ payload: pendingEvents.payload })
        .from(pendingEvents)
        .where(
          and(
            eq(pendingEvents.orgId, orgId),
            sql`${pendingEvents.payload}->'data'->'routineMailboxWait'->>'routineId' = ${routineId}`,
          ),
        ),
    )
  }

  /** The owner's attention row for a waiting run, as the translator writes it. */
  async function seedItemRow(userId: string, runId: string) {
    await withPrivilegedDb(orgId, "rmw-item-row", (tx) =>
      tx.insert(attentionEvents).values({
        orgId,
        userId,
        app: "kernel",
        entityType: "agent_notification",
        entityId: mailboxWaitEntityId(runId),
        kind: "routine_mailbox_wait",
        urgency: 60,
        summary: "waiting",
        actorType: "system",
        occurredAt: new Date(),
        digestEligibleAt: new Date(),
      }),
    )
  }

  async function itemRowUnread(userId: string, runId: string): Promise<boolean> {
    const rows = await withPrivilegedDb(orgId, "rmw-item-read", (tx) =>
      tx
        .select({ readAt: attentionEvents.readAt })
        .from(attentionEvents)
        .where(
          and(
            eq(attentionEvents.orgId, orgId),
            eq(attentionEvents.userId, userId),
            eq(attentionEvents.entityId, mailboxWaitEntityId(runId)),
          ),
        ),
    )
    return rows.some((r) => r.readAt === null)
  }

  it("parks on the owner's locked private mailbox: no plaintext anywhere, one Home item", async () => {
    const routine = await makeRoutine(orgId, owner)
    const seen: Array<{ frame: RunContext | undefined; status: string; emitted: number }> = []
    const first = await tick(routine.id, { agentInvoker: mailReadingInvoker({ seen }) })
    expect(first.status).toBe("waiting_mailbox")
    // The turn got the locked result and nothing was asked of any browser.
    expect(seen[0]?.status).toBe(MAILBOX_LOCKED)
    expect(seen[0]?.emitted).toBe(0)

    const [run] = await runsOf(routine.id)
    expect(run.status).toBe("waiting_mailbox")
    expect(run.mailboxWait?.ownerUserId).toBe(owner)
    expect(run.mailboxWait?.accountId).toBe(ACCOUNT)
    expect(Date.parse(run.mailboxWait?.expiresAt ?? "") - Date.now()).toBeGreaterThan(
      23 * 3600 * 1000,
    )
    expect(JSON.stringify(run)).not.toContain(SECRET)

    // A second scheduled tick while it waits is skipped: still one wait, one item.
    await clearRedisPatterns(["routine-lock:*"])
    const second = await tick(routine.id, { agentInvoker: mailReadingInvoker({}) })
    expect(second.status).toBe("skipped_overlap")
    const runs = await runsOf(routine.id)
    expect(runs.filter((r) => r.status === "waiting_mailbox")).toHaveLength(1)
    expect(runs.find((r) => r.status === "skipped_overlap")?.error).toBe(MAILBOX_WAIT_SKIP_REASON)
    const items = await waitItems(routine.id)
    expect(items).toHaveLength(1)
    const payload = items[0].payload as {
      data: { targetUserIds: string[]; routineMailboxWait: { runId: string } }
    }
    expect(payload.data.targetUserIds).toEqual([owner])
    expect(payload.data.routineMailboxWait.runId).toBe(run.id)
    expect(JSON.stringify(items)).not.toContain(SECRET)
  })

  it("files the item in the owner's approvals list, its own kind, for the owner alone", async () => {
    const routine = await makeRoutine(orgId, owner)
    await tick(routine.id, { agentInvoker: mailReadingInvoker({}) })
    const [run] = await runsOf(routine.id)
    const [item] = await waitItems(routine.id)
    const event = item.payload as {
      app: string
      entity: string
      action: string
      entityId: string
      data: {
        targetUserIds: string[]
        routineMailboxWait: { routineName: string; expiresAt: string; trigger: unknown }
      }
    }
    expect(event.entityId).toBe(mailboxWaitEntityId(run.id))
    expect(event.data.routineMailboxWait.routineName).toBe(routine.name)
    expect(event.data.routineMailboxWait.expiresAt).toBe(run.mailboxWait?.expiresAt as string)
    expect(event.data.routineMailboxWait.trigger).toBeNull()
    // Exactly one translation files it, as `routine_mailbox_wait`, for the
    // owner named on the event and nobody else: not a bottom-of-the-feed
    // agent notification as well.
    const matched = kernelTranslations.filter(
      (t) =>
        t.event === `${event.entity}:${event.action}` &&
        t.app === event.app &&
        (!t.when || evaluatePredicate(t.when, event)),
    )
    expect(matched.map((t) => t.kind)).toEqual(["routine_mailbox_wait"])
    expect(matched[0]?.recipients).toEqual({ kind: "participants", path: "data.targetUserIds" })
    expect(event.data.targetUserIds).toEqual([owner])
    expect(matched[0]?.metadataFromData).toContain("routineMailboxWait")
  })

  it("an event that arrives while a run waits is not dropped: it parks its own run", async () => {
    const routine = await makeRoutine(orgId, owner)
    const mailEvent = (n: number) => ({
      app: "mail",
      entity: "message",
      action: "create",
      entityId: `m-${n}`,
      data: {},
      origin: "external" as const,
      eventId: crypto.randomUUID(),
    })
    const first = await tick(routine.id, {
      triggerEvent: mailEvent(1),
      agentInvoker: mailReadingInvoker({}),
    })
    expect(first.status).toBe("waiting_mailbox")
    const statuses: string[] = []
    for (const n of [2, 3, 4]) {
      await clearRedisPatterns(["routine-lock:*"])
      const seen: Array<{ frame: RunContext | undefined; status: string; emitted: number }> = []
      const next = await tick(routine.id, {
        triggerEvent: mailEvent(n),
        agentInvoker: mailReadingInvoker({ seen }),
      })
      statuses.push(next.status)
      // It ran without anyone's browser: the read was refused, nothing was asked.
      expect(seen[0]?.status).toBe(MAILBOX_LOCKED)
      expect(seen[0]?.emitted).toBe(0)
    }
    expect(statuses).toEqual(["waiting_mailbox", "waiting_mailbox", "waiting_mailbox"])
    const runs = await runsOf(routine.id)
    expect(runs.filter((r) => r.status === "skipped_overlap")).toHaveLength(0)
    const waiting = runs.filter((r) => r.status === "waiting_mailbox")
    expect(waiting.map((r) => r.mailboxWait?.triggerEvent?.entityId).sort()).toEqual([
      "m-1",
      "m-2",
      "m-3",
      "m-4",
    ])
    // One item per waiting run, each saying a new email started it.
    const items = await waitItems(routine.id)
    expect(items).toHaveLength(4)
    for (const i of items) {
      expect(
        (i.payload as { data: { routineMailboxWait: { trigger: unknown } } }).data
          .routineMailboxWait.trigger,
      ).toEqual({ app: "mail", entity: "message", action: "create" })
    }
    // A scheduled tick is still held by the waits: one routine, not a pile of hourly waits.
    await clearRedisPatterns(["routine-lock:*"])
    expect((await tick(routine.id, { agentInvoker: mailReadingInvoker({}) })).status).toBe(
      "skipped_overlap",
    )
  })

  it("Dismiss: only the owner, the run says dismissed, its item leaves the list", async () => {
    const routine = await makeRoutine(orgId, owner)
    await tick(routine.id, { agentInvoker: mailReadingInvoker({}) })
    const [waiting] = await runsOf(routine.id)
    await seedItemRow(owner, waiting.id)
    const dismiss = (userId: string) =>
      dismissWaitingMailboxRun({ orgId, userId, routineId: routine.id, runId: waiting.id })
    expect(await dismiss(admin)).toMatchObject({ ok: false, code: "not_found" })
    expect((await runsOf(routine.id))[0]?.status).toBe("waiting_mailbox")
    expect(await itemRowUnread(owner, waiting.id)).toBe(true)

    expect(await dismiss(owner)).toEqual({ ok: true, runId: waiting.id })
    const [row] = await runsOf(routine.id)
    expect(row.status).toBe("mailbox_wait_dismissed")
    expect(await itemRowUnread(owner, waiting.id)).toBe(false)
    // Gone: Run now no longer finds it, a second dismiss neither.
    expect(
      await runWaitingMailboxRun(
        { orgId, userId: owner, routineId: routine.id, runId: waiting.id, turnNonce: "nonce-dis" },
        { startTick: async () => ({ status: "no_run" }) },
      ),
    ).toMatchObject({ ok: false, code: "not_found" })
    expect(await dismiss(owner)).toMatchObject({ ok: false, code: "not_found" })
  })

  it("runs only on the owner's Run now, with the nonce their browser minted", async () => {
    const routine = await makeRoutine(orgId, owner)
    await tick(routine.id, { agentInvoker: mailReadingInvoker({}) })
    const [waiting] = await runsOf(routine.id)
    const started: RoutineTickOpts[] = []
    const startTick = async (opts: RoutineTickOpts) => {
      started.push(opts)
      return { status: "no_run" as const, runId: waiting.id }
    }
    const ask = (userId: string, deps = { startTick }) =>
      runWaitingMailboxRun(
        { orgId, userId, routineId: routine.id, runId: waiting.id, turnNonce: "browser-nonce-1" },
        deps,
      )

    // Anyone else's session is refused, an admin's included.
    expect(await ask(admin)).toMatchObject({ ok: false, code: "not_found" })
    expect(started).toHaveLength(0)

    await seedItemRow(owner, waiting.id)
    expect(await ask(owner)).toEqual({
      ok: true,
      runId: waiting.id,
      queued: false,
      handoff: null,
      settled: expect.any(Promise),
    })
    expect(started).toHaveLength(1)
    // Run now took the item out of the owner's list.
    expect(await itemRowUnread(owner, waiting.id)).toBe(false)
    expect(started[0]).toMatchObject({
      requestedByUserId: owner,
      mailboxTurnNonce: "browser-nonce-1",
      mailboxWaitRunId: waiting.id,
    })
    // A second press is refused while it runs.
    expect(await ask(owner)).toMatchObject({ ok: false, code: "claimed" })

    // The run itself: the turn carries the browser's nonce, so its read goes to
    // that browser, which answers it; nothing parks again; the waiting row is
    // the row the run ends in.
    await clearRedisPatterns(["routine-lock:*"])
    const emitted: Array<Record<string, unknown>> = []
    const contexts: string[] = []
    const seen: Array<{ frame: RunContext | undefined; status: string; emitted: number }> = []
    const result = await tick(routine.id, {
      ...started[0],
      agentInvoker: mailReadingInvoker({
        seen,
        emitted,
        contexts,
        browserNonce: "browser-nonce-1",
      }),
    })
    expect(seen[0]?.frame?.mailboxTurnNonce).toBe("browser-nonce-1")
    expect(seen[0]?.frame?.routineMailboxWait).toBeUndefined()
    expect(emitted[0]?.turnNonce).toBe("browser-nonce-1")
    expect(seen[0]?.status).toBe("delivered")
    // The plaintext is the turn's ephemeral context, never stored on the run.
    expect(contexts.join("\n")).toContain(SECRET)
    expect(result.runId).toBe(waiting.id)
    const [row] = (await runsOf(routine.id)).filter((r) => r.id === waiting.id)
    expect(row.status).toBe("succeeded")
    expect(JSON.stringify(row)).not.toContain(SECRET)
  }, 60_000)

  it("keeps the event's ids only; Run now reads its data back from the audit log", async () => {
    const routine = await makeRoutine(orgId, owner)
    const eventId = crypto.randomUUID()
    const triggerEvent = {
      app: "mail",
      entity: "message",
      action: "create",
      entityId: "m1",
      data: { subject: SECRET },
      origin: "external" as const,
      eventId,
    }
    await tick(routine.id, { triggerEvent, agentInvoker: mailReadingInvoker({}) })
    const [waiting] = await runsOf(routine.id)
    expect(waiting.status).toBe("waiting_mailbox")
    expect(waiting.mailboxWait?.triggerEvent).toEqual({
      app: "mail",
      entity: "message",
      action: "create",
      entityId: "m1",
      origin: "external",
      eventId,
    })
    expect(JSON.stringify(waiting)).not.toContain(SECRET)

    await withPrivilegedDb(orgId, "rmw-audit", (tx) =>
      tx.insert(auditLog).values({
        orgId,
        actorType: "system",
        app: "mail",
        entityType: "message",
        entityId: "m1",
        action: "create",
        changes: { subject: "read back" },
        eventId,
      }),
    )
    const started: RoutineTickOpts[] = []
    const outcome = await runWaitingMailboxRun(
      { orgId, userId: owner, routineId: routine.id, runId: waiting.id, turnNonce: "n-ev" },
      {
        startTick: async (opts) => {
          started.push(opts)
          return { status: "no_run" as const, runId: waiting.id }
        },
      },
    )
    expect(outcome).toEqual({
      ok: true,
      runId: waiting.id,
      queued: false,
      handoff: null,
      settled: expect.any(Promise),
    })
    expect(started[0]?.triggerEvent).toMatchObject({
      entityId: "m1",
      eventId,
      data: { subject: "read back" },
    })
  })

  it("expires after 24 hours: Run now is refused and the run says so", async () => {
    const routine = await makeRoutine(orgId, owner)
    await tick(routine.id, { agentInvoker: mailReadingInvoker({}) })
    const [waiting] = await runsOf(routine.id)
    const past = new Date(Date.now() - 1000).toISOString()
    await withPrivilegedDb(orgId, "rmw-age", (tx) =>
      tx
        .update(routineRuns)
        .set({ mailboxWait: { ...waiting.mailboxWait!, expiresAt: past } })
        .where(eq(routineRuns.id, waiting.id)),
    )
    await seedItemRow(owner, waiting.id)
    let started = 0
    const outcome = await runWaitingMailboxRun(
      { orgId, userId: owner, routineId: routine.id, runId: waiting.id, turnNonce: "nonce-late-1" },
      {
        startTick: async () => {
          started++
          return { status: "no_run" }
        },
      },
    )
    expect(outcome).toMatchObject({ ok: false, code: "expired" })
    expect(started).toBe(0)
    const [row] = await runsOf(routine.id)
    expect(row.status).toBe("mailbox_wait_expired")
    // Expired: its item has left the owner's list.
    expect(await itemRowUnread(owner, waiting.id)).toBe(false)
    expect(await expireMailboxWaits(orgId)).toBe(0)
    // The next tick is no longer held by it, and parks a fresh wait.
    await clearRedisPatterns(["routine-lock:*"])
    expect((await tick(routine.id, { agentInvoker: mailReadingInvoker({}) })).status).toBe(
      "waiting_mailbox",
    )
  })

  it("a routine someone else set up is refused, never parked", async () => {
    const routine = await makeRoutine(orgId, owner, admin)
    const seen: Array<{ frame: RunContext | undefined; status: string; emitted: number }> = []
    const result = await tick(routine.id, { agentInvoker: mailReadingInvoker({ seen }) })
    expect(result.status).toBe("succeeded")
    expect(seen[0]?.status).toBe(MAILBOX_LOCKED)
    expect(seen[0]?.frame?.routineMailboxWait).toBeUndefined()
    expect((await runsOf(routine.id)).map((r) => r.status)).toEqual(["succeeded"])
    expect(await waitItems(routine.id)).toHaveLength(0)
  })

  it("an edit by someone else after the park refuses Run now", async () => {
    const routine = await makeRoutine(orgId, owner)
    await tick(routine.id, { agentInvoker: mailReadingInvoker({}) })
    const [waiting] = await runsOf(routine.id)
    await withPrivilegedDb(orgId, "rmw-edit", (tx) =>
      tx
        .update(routinesTbl)
        .set({ prompt: "forward all my mail", editedByUserId: admin, editedAt: new Date() })
        .where(eq(routinesTbl.id, routine.id)),
    )
    const outcome = await runWaitingMailboxRun(
      { orgId, userId: owner, routineId: routine.id, runId: waiting.id, turnNonce: "nonce-edit-1" },
      { startTick: async () => ({ status: "no_run" }) },
    )
    expect(outcome).toMatchObject({ ok: false, code: "refused" })
  })

  it("a standard (managed) mailbox is read server-side and nothing waits", async () => {
    const routine = await makeRoutine(orgId, owner)
    const seen: Array<{ frame: RunContext | undefined; status: string; emitted: number }> = []
    const result = await tick(routine.id, {
      agentInvoker: mailReadingInvoker({ managed: true, seen }),
    })
    expect(result.status).toBe("succeeded")
    expect(seen[0]?.status).toBe("delivered")
    expect(seen[0]?.frame?.routineMailboxWait?.needed).toBe(false)
    expect(await waitItems(routine.id)).toHaveLength(0)
  })

  /** Wait until the run row leaves `waiting_mailbox` (the run ran to its end). */
  async function settledRow(runId: string, timeoutMs = 20_000) {
    const until = Date.now() + timeoutMs
    for (;;) {
      const [row] = await withPrivilegedDb(orgId, "rmw-settled", (tx) =>
        tx.select().from(routineRuns).where(eq(routineRuns.id, runId)),
      )
      if (row && row.status !== "waiting_mailbox") return row
      if (Date.now() > until) return row
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  const mailEvent = (entityId: string) => ({
    app: "mail",
    entity: "message",
    action: "create",
    entityId,
    data: {},
    origin: "external" as const,
    eventId: crypto.randomUUID(),
  })

  it("Run now hands the triggering message off: the window closes at once and the run still completes", async () => {
    const routine = await makeRoutine(orgId, owner)
    await tick(routine.id, { triggerEvent: mailEvent("m1"), agentInvoker: mailReadingInvoker({}) })
    const [waiting] = await runsOf(routine.id)
    expect(waiting.status).toBe("waiting_mailbox")

    const emitted: Array<Record<string, unknown>> = []
    const contexts: string[] = []
    const answers: Array<{ status?: string; reason?: string }> = []
    const seen: Array<{ frame: RunContext | undefined; status: string; emitted: number }> = []
    const lookups: Array<{ userId: string; entityId?: string | null }> = []
    const outcome = await runWaitingMailboxRun(
      { orgId, userId: owner, routineId: routine.id, runId: waiting.id, turnNonce: "nonce-hand-1" },
      {
        handoffMessageIds: async ({ userId, event }) => {
          lookups.push({ userId, entityId: event?.entityId })
          return ["m1"]
        },
        // The real tick. The owner's window is gone (closed right after the
        // click): no unlock assertion, nobody to answer a live read.
        startTick: (opts) =>
          tick(routine.id, {
            ...opts,
            agentInvoker: mailReadingInvoker({
              unlocked: false,
              emitted,
              contexts,
              answers,
              seen,
              alsoRead: "m9",
            }),
          }),
      },
    )
    expect(outcome).toMatchObject({ ok: true, runId: waiting.id, queued: false })
    if (!outcome.ok || !outcome.handoff) throw new Error("expected a handoff request")
    expect(outcome.handoff.messageIds).toEqual(["m1"])
    expect(lookups).toEqual([{ userId: owner, entityId: "m1" }])

    // No plaintext without the owner's click: the request is bound to the
    // click's nonce and to the owner.
    const answer = {
      kind: "plaintext" as const,
      items: [
        { messageId: "m1", subject: "Hi", textBody: SECRET },
        // Not asked for: never held for the run.
        { messageId: "m9", subject: "Other", textBody: "NOT-ASKED-FOR" },
      ],
      undecryptable: [],
    }
    expect(
      resolveMailboxRequest(outcome.handoff.requestId, {
        userId: admin,
        turnNonce: "nonce-hand-1",
        response: answer,
      }),
    ).toBe("not_found")
    expect(
      resolveMailboxRequest(outcome.handoff.requestId, {
        userId: owner,
        turnNonce: "some-other-nonce",
        response: answer,
      }),
    ).toBe("nonce_mismatch")
    // The owner's browser answers it in the click, then the window closes.
    expect(
      resolveMailboxRequest(outcome.handoff.requestId, {
        userId: owner,
        turnNonce: "nonce-hand-1",
        response: answer,
      }),
    ).toBe("resolved")

    const row = await settledRow(waiting.id)
    expect(row.status).toBe("succeeded")
    // The triggering message came from the handoff: no browser was asked.
    expect(seen[0]?.status).toBe("delivered")
    expect(emitted).toHaveLength(0)
    expect(contexts.join("\n")).toContain(SECRET)
    expect(contexts.join("\n")).not.toContain("NOT-ASKED-FOR")
    // Another private read, with no window open: the named result, at once.
    expect(answers[1]).toMatchObject({ status: MAILBOX_LOCKED, reason: MAILBOX_NEEDS_WINDOW })
    // Held for the run only: emptied once it ended, and never stored. The row
    // reads `succeeded` a moment before the launch lets the handoff go.
    await outcome.settled
    expect(seen[0]?.frame?.mailboxHandoff?.items.size).toBe(0)
    expect(JSON.stringify(row)).not.toContain(SECRET)
  }, 60_000)

  it("a run with no Run now never holds a handoff, and a refused handoff releases nothing", async () => {
    const routine = await makeRoutine(orgId, owner)
    const seen: Array<{ frame: RunContext | undefined; status: string; emitted: number }> = []
    await tick(routine.id, {
      triggerEvent: mailEvent("m1"),
      agentInvoker: mailReadingInvoker({ seen }),
    })
    expect(seen[0]?.frame?.mailboxHandoff).toBeUndefined()
    const [waiting] = await runsOf(routine.id)
    const answers: Array<{ status?: string; reason?: string }> = []
    const contexts: string[] = []
    const outcome = await runWaitingMailboxRun(
      { orgId, userId: owner, routineId: routine.id, runId: waiting.id, turnNonce: "nonce-hand-2" },
      {
        handoffMessageIds: async () => ["m1"],
        startTick: (opts) =>
          tick(routine.id, {
            ...opts,
            agentInvoker: mailReadingInvoker({ unlocked: false, answers, contexts }),
          }),
      },
    )
    if (!outcome.ok || !outcome.handoff) throw new Error("expected a handoff request")
    // The owner's browser refuses (agent access off, say): nothing is held.
    resolveMailboxRequest(outcome.handoff.requestId, {
      userId: owner,
      turnNonce: "nonce-hand-2",
      response: { kind: "denied", reason: "agent access is off" },
      turnOwner: true,
    })
    expect((await settledRow(waiting.id)).status).toBe("succeeded")
    expect(answers[0]).toMatchObject({ status: MAILBOX_LOCKED, reason: MAILBOX_NEEDS_WINDOW })
    expect(contexts).toHaveLength(0)
  }, 60_000)

  it("two waiting runs on one routine and thread: Run now on both in a row runs both, the second queued", async () => {
    const routine = await makeRoutine(orgId, owner)
    const event = (n: number) => ({ ...mailEvent(`not-a-uuid-${n}`), app: "tickets" })
    await tick(routine.id, { triggerEvent: event(1), agentInvoker: mailReadingInvoker({}) })
    await clearRedisPatterns(["routine-lock:*"])
    await tick(routine.id, { triggerEvent: event(2), agentInvoker: mailReadingInvoker({}) })
    const waits = (await runsOf(routine.id)).filter((r) => r.status === "waiting_mailbox")
    expect(waits).toHaveLength(2)
    expect(waits[0].mailboxWait?.outputThreadId).toBe(waits[1].mailboxWait?.outputThreadId)
    const [first, second] = waits

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen: Array<{ frame: RunContext | undefined; status: string; emitted: number }> = []
    const startFor = (nonce: string, held?: Promise<void>) => (opts: RoutineTickOpts) =>
      tick(routine.id, {
        ...opts,
        agentInvoker: mailReadingInvoker({ browserNonce: nonce, seen, gate: held }),
      })
    const one = await runWaitingMailboxRun(
      { orgId, userId: owner, routineId: routine.id, runId: first.id, turnNonce: "nonce-q-1" },
      { startTick: startFor("nonce-q-1", gate), retryDelayMs: 50 },
    )
    expect(one).toMatchObject({ ok: true, queued: false })
    // Let the first run take the routine lock.
    for (let i = 0; i < 100; i++) {
      const { redis } = await import("~/lib/redis")
      if (await redis.exists(`routine-lock:${routine.id}`)) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const two = await runWaitingMailboxRun(
      { orgId, userId: owner, routineId: routine.id, runId: second.id, turnNonce: "nonce-q-2" },
      { startTick: startFor("nonce-q-2"), retryDelayMs: 50 },
    )
    // Queued behind the first, and the row can say so.
    expect(two).toMatchObject({ ok: true, queued: true })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const [held] = (await runsOf(routine.id)).filter((r) => r.id === second.id)
    expect(held.status).toBe("waiting_mailbox")
    expect(held.mailboxWait?.claimedAt).not.toBeNull()
    // A third press on it is refused by name, not a silent 202.
    expect(
      await runWaitingMailboxRun(
        { orgId, userId: owner, routineId: routine.id, runId: second.id, turnNonce: "nonce-q-3" },
        { startTick: startFor("nonce-q-3") },
      ),
    ).toMatchObject({ ok: false, code: "claimed" })

    release()
    expect((await settledRow(first.id)).status).toBe("succeeded")
    expect((await settledRow(second.id)).status).toBe("succeeded")
    expect(seen.map((s) => s.status)).toEqual(["delivered", "delivered"])
  }, 60_000)
})
