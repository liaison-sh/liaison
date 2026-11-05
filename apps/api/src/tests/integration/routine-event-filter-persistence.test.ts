// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mail sender filter is a routine setting (S26, A32, F4).
//
// event-routine-owner-gate.test.ts proves the subscriber evaluates a filter
// handed to it. This file proves the filter is a property of the ROUTINE: the
// create path stores it and registers the subscription with it, an update
// re-registers with the new one, and the boot reload reads it back from the
// row. A non-matching mail enqueues no tick, so no run row and no output
// thread ever exist for it; a matching contact and a matching group member
// each enqueue exactly one.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import {
  _publishEventInternal,
  flushEventHandlers,
  initEventBus,
  resetEventBus,
} from "~/infra/events/event-bus"
import { resetAppRegistries, setDeclaredEmits } from "~/modules/apps/app-registries"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const enqueued: unknown[][] = []
const upserts: unknown[][] = []
const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (...a: unknown[]) => {
    enqueued.push(a)
    return "job-id"
  },
  // The leader's reload also upserts cron schedulers of other routines in the database.
  upsertJobScheduler: async (...a: unknown[]) => {
    upserts.push(a)
    return undefined
  },
  removeScheduledJob: async () => undefined,
  removeAppJob: async () => undefined,
}))

// mock.module outlives this file: put the real jobs module back so the stubs above
// never reach a later file in the same bun process (a later spyOn(Queue.prototype)
// would otherwise watch a queue the stub never touches).
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const { EventRoutineSubscriberTestAccess, __resetEventRoutineSubscriber } = await import(
  "~/infra/jobs/event-routine-subscriber"
)

// Pin a short coalesce window for this file. The subscriber reads its env once at
// module load, and another file in the same bun process may have loaded it first
// with the 30s default, so the env alone cannot set it.
const COALESCE_MS = 100
beforeAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs(COALESCE_MS))
afterAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs())
const { handleCreateRoutine, handleUpdateRoutine } = await import(
  "~/modules/agent/tools/skills-routines-tools"
)
const { reloadRoutineSchedulers, subscribeEventRoutinesAtBoot } = await import(
  "~/infra/jobs/kernel-jobs"
)

const ticks = () => enqueued.filter(([app, job]) => app === "kernel" && job === "routine-tick")

const ORG = randomUUID()
const OWNER = randomUUID()
const ACC = randomUUID()
const CONV = randomUUID()
const MSG_CLIENT = randomUUID()
const MSG_GROUPED = randomUUID()
const MSG_STRANGER = randomUUID()
const CONTACT_CLIENT = randomUUID()
const CONTACT_GROUPED = randomUUID()
const GROUP = randomUUID()

const ctx = {
  orgId: ORG,
  userId: OWNER,
  actorType: "user",
  scopes: ["*"],
  approverUserId: OWNER,
} as never

async function insertMessage(id: string, from: string) {
  await sql.unsafe(
    `INSERT INTO app_mail.messages
       (id, org_id, conversation_id, account_id, message_references, from_address,
        to_addresses, cc_addresses, bcc_addresses, labels, direction, raw_headers,
        owner_type, owner_id, is_read, is_starred)
     VALUES ('${id}', '${ORG}', '${CONV}', '${ACC}', '[]', '{"email":"${from}"}', '[]', '[]', '[]',
             '[]', 'inbound', '{}', 'user', '${OWNER}', false, false)`,
  )
}

async function mail(id: string, from: string) {
  await _publishEventInternal({
    app: "mail",
    entity: "message",
    action: "create",
    orgId: ORG,
    entityId: id,
    // A sender filter matches only mail the receiving provider authenticated.
    data: {
      id,
      conversationId: CONV,
      accountId: ACC,
      direction: "inbound",
      from: { email: from },
      senderAuth: "pass",
    },
  })
  await flushEventHandlers()
  await new Promise((r) => setTimeout(r, COALESCE_MS + 150))
}

async function runRowsAndThread(routineId: string) {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.routine_runs WHERE routine_id = ${routineId}`
  const [r] = await sql<{ output_thread_id: string | null }[]>`
    SELECT output_thread_id FROM kernel.routines WHERE id = ${routineId}`
  return { runs: n, outputThreadId: r?.output_thread_id ?? null }
}

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_mail")
  try {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Filter Org', ${`filter-${ORG}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${OWNER}, ${ORG}, ${`${OWNER}@filter.test`}, 'Owner', 'active', 'hash')`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${OWNER}, ${ORG}, '*')`
    const { mailAppManifest } = await import("~/apps/mail/manifest-descriptor")
    const { registerApps } = await import("~/modules/apps/runtime")
    initEventBus()
    await registerApps([mailAppManifest as unknown as AppDescriptor], ORG)
    setDeclaredEmits(ORG, "mail", new Set(["message:create"]))

    await sql.unsafe(
      `INSERT INTO app_mail.accounts
         (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
       VALUES ('${ACC}', '${ORG}', gen_random_uuid(), 'user', '${OWNER}', 'gmail', 'owner@filter.test', 'idle')`,
    )
    await sql.unsafe(
      `INSERT INTO app_mail.conversations
         (id, org_id, account_id, owner_type, owner_id, external_thread_id, status,
          labels, is_read, is_starred, message_count)
       VALUES ('${CONV}', '${ORG}', '${ACC}', 'user', '${OWNER}', 'ext-${CONV}', 'open', '[]', false, false, 0)`,
    )
    await insertMessage(MSG_CLIENT, "client@acme.test")
    await insertMessage(MSG_GROUPED, "grouped@acme.test")
    await insertMessage(MSG_STRANGER, "stranger@else.test")
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, email, org_access)
      VALUES (${CONTACT_CLIENT}, ${ORG}, ${`c-${CONTACT_CLIENT}`}, 'client@acme.test', 'viewer'),
             (${CONTACT_GROUPED}, ${ORG}, ${`c-${CONTACT_GROUPED}`}, 'grouped@acme.test', 'viewer')`
    await sql`INSERT INTO kernel.contact_segments (id, org_id, name, kind)
      VALUES (${GROUP}, ${ORG}, 'Prospects', 'manual')`
    await sql`INSERT INTO kernel.contact_group_members (segment_id, contact_id, org_id)
      VALUES (${GROUP}, ${CONTACT_GROUPED}, ${ORG})`
  } catch (err) {
    await releaseAppSchemaJsLock("app_mail")
    throw err
  }
}, 120_000)

afterAll(async () => {
  try {
    await sql.unsafe(`DELETE FROM app_mail.messages WHERE org_id = '${ORG}'`)
    await sql.unsafe(`DELETE FROM app_mail.conversations WHERE org_id = '${ORG}'`)
    await sql.unsafe(`DELETE FROM app_mail.accounts WHERE org_id = '${ORG}'`)
    await sql`DELETE FROM kernel.contact_group_members WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contact_segments WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
    // Creating a routine opens its output thread with the owner as participant.
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    resetAppRegistries()
  } finally {
    await releaseAppSchemaJsLock("app_mail")
  }
})

beforeEach(() => {
  enqueued.length = 0
  __resetEventRoutineSubscriber()
  resetEventBus()
  initEventBus()
  setDeclaredEmits(ORG, "mail", new Set(["message:create"]))
})

describe("a routine's sender filter is stored and applied (S26)", () => {
  test("create stores a group filter: a stranger enqueues nothing, a group member one tick", async () => {
    const res = (await handleCreateRoutine(
      {
        name: `prospect-mail-${ORG.slice(0, 8)}`,
        description: "React to prospect mail",
        kind: "event",
        event: "mail:message:create",
        prompt: "Draft a reply to the prospect.",
        scopes: ["mail:conversations:read"],
        eventFilter: { fromGroupIds: [GROUP] },
      },
      ctx,
    )) as { routine?: { id: string; eventFilter?: unknown }; error?: unknown }
    expect(res.error).toBeUndefined()
    const id = res.routine!.id
    expect(res.routine!.eventFilter).toEqual({ fromGroupIds: [GROUP] })
    const [stored] = await sql<{ event_filter: unknown }[]>`
      SELECT event_filter FROM kernel.routines WHERE id = ${id}`
    expect(stored.event_filter).toEqual({ fromGroupIds: [GROUP] })

    await mail(MSG_STRANGER, "stranger@else.test")
    expect(ticks().length).toBe(0)
    expect(await runRowsAndThread(id)).toEqual({ runs: 0, outputThreadId: null })

    await mail(MSG_GROUPED, "grouped@acme.test")
    expect(ticks().length).toBe(1)
    expect(ticks()[0][2]).toMatchObject({ routineId: id, orgId: ORG })
  })

  test("update to a contact filter re-registers: the contact matches, the group member no longer", async () => {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.routines WHERE org_id = ${ORG} LIMIT 1`
    // Registered by the create (the subscriber state is reset between tests).
    const { registerEventRoutineSubscription } = await import(
      "~/infra/jobs/event-routine-subscriber"
    )
    await registerEventRoutineSubscription({
      routineId: row.id,
      orgId: ORG,
      event: "mail:message:create",
      filter: { fromGroupIds: [GROUP] },
    })
    const res = (await handleUpdateRoutine(
      { id: row.id, eventFilter: { fromContactIds: [CONTACT_CLIENT] } },
      ctx,
    )) as { routine?: { eventFilter?: unknown }; error?: unknown }
    expect(res.error).toBeUndefined()
    expect(res.routine!.eventFilter).toEqual({ fromContactIds: [CONTACT_CLIENT] })

    await mail(MSG_GROUPED, "grouped@acme.test")
    expect(ticks().length).toBe(0)
    await mail(MSG_CLIENT, "client@acme.test")
    expect(ticks().length).toBe(1)
  })

  test("the boot reload reads the filter back from the row", async () => {
    await subscribeEventRoutinesAtBoot()
    await mail(MSG_STRANGER, "stranger@else.test")
    expect(ticks().length).toBe(0)
    await mail(MSG_CLIENT, "client@acme.test")
    expect(ticks().length).toBe(1)
  })

  test("the per-process boot load only subscribes; the schedulers are the leader's reload", async () => {
    const res = (await handleCreateRoutine(
      {
        name: `recurring-${ORG.slice(0, 8)}`,
        description: "d",
        kind: "recurring",
        cron: "0 7 * * *",
        timezone: "UTC",
        prompt: "p",
        scopes: [],
      },
      ctx,
    )) as { routine?: { id: string }; error?: unknown }
    expect(res.error).toBeUndefined()
    const id = res.routine?.id
    upserts.length = 0
    enqueued.length = 0
    await subscribeEventRoutinesAtBoot()
    expect(upserts).toEqual([])
    expect(ticks()).toEqual([])
    await reloadRoutineSchedulers()
    const ids = upserts.map((a) => (a[3] as { schedulerId?: string } | undefined)?.schedulerId)
    expect(ids).toContain(`routine:${id}`)
  })

  test("a filter on any other event is refused", async () => {
    setDeclaredEmits(ORG, "mail", new Set(["message:create", "conversation:create"]))
    const res = (await handleCreateRoutine(
      {
        name: `conv-filter-${ORG.slice(0, 8)}`,
        description: "d",
        kind: "event",
        event: "mail:conversation:create",
        prompt: "p",
        scopes: [],
        eventFilter: { fromGroupIds: [GROUP] },
      },
      ctx,
    )) as { error?: { code: string } }
    expect(res.error?.code).toBe("invalid_event_filter")
  })
})
