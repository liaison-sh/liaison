// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as privilegedModule from "~/db/privileged"
import {
  DurableConsumersTestAccess,
  durableConsumerCount,
  runDurableConsumers,
} from "~/infra/events/durable-consumers"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { entityRegistry } from "~/modules/apps/app-registries"
import * as liveIndexModule from "~/modules/search/live-index-queue"

const ORG = "33333333-3333-3333-3333-333333333333"
const TICKET_ID = "44444444-4444-4444-4444-444444444444"
const THREAD_ID = "55555555-5555-5555-5555-555555555555"
const DOC_ID = "66666666-6666-6666-6666-666666666666"
const TASK_ID = "77777777-7777-7777-7777-777777777777"

const enqueued: Array<{
  appName: string
  jobName: string
  payload: any
  opts?: { jobId?: string }
}> = []
const enqueueAppJobMock = mock<
  (appName: string, jobName: string, payload: any, opts?: any) => Promise<string>
>(async (appName, jobName, payload, opts) => {
  enqueued.push({ appName, jobName, payload, opts })
  return opts?.jobId ?? `${appName}:${jobName}:auto`
})

const registerJobWorkerMock = mock<(...args: any[]) => void>(() => {})

// What the live path recorded into the coalescing queue (live-index-queue.ts).
const recorded: liveIndexModule.LiveIndexItem[] = []
const recordLiveIndexMock = mock(async (items: liveIndexModule.LiveIndexItem[]) => {
  recorded.push(...items)
})

const meiliAddDocuments = mock<(docs: any[]) => Promise<{ taskUid: number }>>(async () => ({
  taskUid: 1,
}))
const meiliDeleteDocument = mock<(id: string) => Promise<{ taskUid: number }>>(async () => ({
  taskUid: 2,
}))

const privilegedRows: Record<string, any> = {
  ticket: {
    id: TICKET_ID,
    subject: "USB detection bug",
    description: "logs missing",
    team: "platform",
  },
  document: {
    id: DOC_ID,
    title: "Confidential doc",
    body: "body",
    org_wide: false,
    acl_user_ids: [],
    acl_role_ids: [],
  },
  task: {
    id: TASK_ID,
    title: "Tessera Lab: Key of C triggers sound of A",
    description: null,
  },
}

let currentReadRow: any = privilegedRows.ticket
// Rows returned for the `ticketIdsForContact` fan-out lookup (a SELECT id ...
// WHERE contact_id = ... query) — keyed off `_purpose` since it uses a
// distinct withPrivilegedDb reason string ("indexer:tickets:contact-fanout")
// unlike the generic per-entity upsert read ("indexer:<app>").
let currentContactFanoutRows: Array<{ id: string }> = []

const withPrivilegedDbMock = mock(async (_org: string, purpose: string, fn: any) => {
  const tx = {
    execute: async (_query: any) => {
      if (purpose === "indexer:tickets:contact-fanout") {
        return { rows: currentContactFanoutRows }
      }
      return { rows: [currentReadRow] }
    },
  }
  return fn(tx)
})

const spies: Array<{ mockRestore: () => void }> = []

beforeEach(() => {
  enqueued.length = 0
  recorded.length = 0
  recordLiveIndexMock.mockClear()
  enqueueAppJobMock.mockClear()
  registerJobWorkerMock.mockClear()
  meiliAddDocuments.mockClear()
  meiliDeleteDocument.mockClear()
  withPrivilegedDbMock.mockClear()
  DurableConsumersTestAccess.reset()
  currentReadRow = privilegedRows.ticket
  currentContactFanoutRows = []
  // Allow re-registration across tests.
  // biome-ignore lint/suspicious/noExplicitAny: test reset
  ;(globalThis as any).__indexerRegistered = false

  spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation(enqueueAppJobMock))
  spies.push(spyOn(jobsModule, "registerJobWorker").mockImplementation(registerJobWorkerMock))
  spies.push(spyOn(jobsModule, "upsertJobScheduler").mockImplementation(async () => {}))
  spies.push(spyOn(liveIndexModule, "recordLiveIndex").mockImplementation(recordLiveIndexMock))
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue("test_idx"))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue({
      index: () => ({
        addDocuments: meiliAddDocuments,
        deleteDocument: meiliDeleteDocument,
        // Every write goes through index-writer.ts, which deletes by id list.
        deleteDocuments: async (ids: string[]) => {
          for (const id of ids) await meiliDeleteDocument(id)
          return { taskUid: 2 }
        },
      }),
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any),
  )
  spies.push(spyOn(privilegedModule, "withPrivilegedDb").mockImplementation(withPrivilegedDbMock))

  entityRegistry.set([ORG, "tickets", "ticket"], {
    labelField: "subject",
    handlePrefix: "tk",
    searchable: true,
    tableName: "tickets",
    schemaName: "app_tickets",
    readScope: "tickets:tickets:read",
    indexFields: { title: "subject", body: "description" },
    permissionFields: {
      readScope: "tickets:tickets:read",
      dimensionFields: ["team"],
    },
  } as any)

  entityRegistry.set([ORG, "knowledge", "document"], {
    labelField: "title",
    handlePrefix: "doc",
    searchable: true,
    tableName: "documents",
    schemaName: "app_knowledge",
    readScope: "knowledge:documents:read",
    indexFields: { title: "title", body: "body" },
    permissionFields: {
      readScope: "knowledge:documents:read",
      aclFields: {
        orgWideField: "org_wide",
        userIdsField: "acl_user_ids",
        roleIdsField: "acl_role_ids",
      },
    },
  } as any)

  // Mirrors the real projects app.manifest.json's `task` entity registration
  // (PRJ-2): searchable, with indexFields, but — like every projects event —
  // its create/update/delete events use PAST-TENSE verbs.
  entityRegistry.set([ORG, "projects", "task"], {
    labelField: "title",
    handlePrefix: "task",
    searchable: true,
    tableName: "tasks",
    schemaName: "app_projects",
    readScope: "projects:projects:read",
    indexFields: { title: "title", body: "description" },
    permissionFields: {
      readScope: "projects:projects:read",
    },
  } as any)
})

afterEach(() => {
  for (const s of spies) s.mockRestore()
  spies.length = 0
  entityRegistry.delete([ORG, "tickets", "ticket"])
  entityRegistry.delete([ORG, "knowledge", "document"])
  entityRegistry.delete([ORG, "projects", "task"])
  DurableConsumersTestAccess.reset()
})

async function loadIndexer() {
  return await import("./indexer")
}

describe("indexer durable consumer registration", () => {
  it("registerIndexerConsumer adds a durable event consumer", async () => {
    const indexer = await loadIndexer()
    expect(durableConsumerCount()).toBe(0)
    indexer.registerIndexerConsumer()
    expect(durableConsumerCount()).toBe(1)
  })

  it("registerIndexerConsumer registers upsert and delete job workers", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    const jobNames = registerJobWorkerMock.mock.calls.map((c) => `${c[0]}:${c[1]}`)
    expect(jobNames).toContain("kernel:search-index-upsert")
    expect(jobNames).toContain("kernel:search-index-delete")
  })

  it("registerIndexerJobWorkers registers the job handlers WITHOUT a durable event consumer (for the worker process)", async () => {
    // A dedicated job-worker process competes for app-kernel jobs, so it
    // must hold the search-index handlers — but it must NOT add a second event
    // consumer (the API owns event→job enqueue). Regression for the worker grabbing
    // a search-index-upsert job with no handler → exhausted retries → server_error_rate.
    const indexer = await loadIndexer()
    expect(durableConsumerCount()).toBe(0)
    indexer.registerIndexerJobWorkers()
    expect(durableConsumerCount()).toBe(0) // no event consumer added
    const jobNames = registerJobWorkerMock.mock.calls.map((c) => `${c[0]}:${c[1]}`)
    expect(jobNames).toContain("kernel:search-index-upsert")
    expect(jobNames).toContain("kernel:search-index-delete")
  })
})

describe("indexer durable consumer event translation", () => {
  it("create event on a searchable ticket enqueues an upsert with a deterministic id", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-1",
      event: {
        app: "tickets",
        entity: "ticket",
        action: "create",
        orgId: ORG,
        entityId: TICKET_ID,
        data: {},
      },
    })
    expect(recorded).toHaveLength(1)
    const call = recorded[0]!
    expect(call.t).toBe("entity")
    expect(call.payload.action).toBe("upsert")
    expect(call.key).toBe(`${ORG}_tickets_ticket_${TICKET_ID}`)
  })

  it("delete event on a searchable ticket enqueues a delete job", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-2",
      event: {
        app: "tickets",
        entity: "ticket",
        action: "delete",
        orgId: ORG,
        entityId: TICKET_ID,
        data: {},
      },
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.payload.action).toBe("delete")
  })

  it("ephemeral events are skipped", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-3",
      event: {
        app: "tickets",
        entity: "ticket",
        action: "update",
        orgId: ORG,
        entityId: TICKET_ID,
        ephemeral: true,
      },
    })
    expect(recorded).toEqual([])
  })

  it("events on non-registered entities are dropped", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-4",
      event: {
        app: "unknown",
        entity: "widget",
        action: "create",
        orgId: ORG,
        entityId: "x",
      },
    })
    expect(recorded).toEqual([])
  })

  it("projects:task created (past-tense verb) enqueues an upsert (PRJ-2 root cause)", async () => {
    // The projects app emits `task:created`/`task:updated`/`task:deleted`
    // (past tense) rather than the documented imperative convention — before
    // the fix, planFromEvent's generic branch only matched "create"/"update"/
    // "delete", so a task's own creation event silently matched nothing and
    // the task was never queued for indexing at all, regardless of
    // `indexFields`.
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-task-1",
      event: {
        app: "projects",
        entity: "task",
        action: "created",
        orgId: ORG,
        entityId: TASK_ID,
        data: {},
      },
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.payload).toMatchObject({
      action: "upsert",
      app: "projects",
      entityType: "task",
      entityId: TASK_ID,
    })
  })

  it("projects:task updated (past-tense verb) enqueues an upsert", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-task-2",
      event: {
        app: "projects",
        entity: "task",
        action: "updated",
        orgId: ORG,
        entityId: TASK_ID,
        data: {},
      },
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.payload.action).toBe("upsert")
  })

  it("projects:task deleted (past-tense verb) enqueues a delete job", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-task-3",
      event: {
        app: "projects",
        entity: "task",
        action: "deleted",
        orgId: ORG,
        entityId: TASK_ID,
        data: {},
      },
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.payload.action).toBe("delete")
  })

  it("participant:add enqueues a thread upsert (kernel's real emit shape)", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-5",
      event: {
        app: "kernel",
        entity: "participant",
        action: "add",
        orgId: ORG,
        entityId: THREAD_ID,
        data: { threadId: THREAD_ID, userId: "u-1" },
      },
    })
    expect(recorded).toHaveLength(1)
    const call = recorded[0]!
    expect(call.payload.action).toBe("upsert")
    expect(call.key).toBe(`${ORG}_kernel_thread_${THREAD_ID}`)
  })

  it("participant:remove enqueues a thread upsert (re-indexes participant_ids)", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-5b",
      event: {
        app: "kernel",
        entity: "participant",
        action: "remove",
        orgId: ORG,
        entityId: THREAD_ID,
        data: { threadId: THREAD_ID, userId: "u-1" },
      },
    })
    expect(recorded).toHaveLength(1)
    const call = recorded[0]!
    expect(call.payload.action).toBe("upsert")
    expect(call.key).toBe(`${ORG}_kernel_thread_${THREAD_ID}`)
  })

  it("share action on a searchable entity enqueues an upsert (ACL fields must reindex)", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-6",
      event: {
        app: "knowledge",
        entity: "document",
        action: "share",
        orgId: ORG,
        entityId: DOC_ID,
        data: { id: DOC_ID },
      },
    })
    expect(recorded).toHaveLength(1)
    const call = recorded[0]!
    expect(call.payload.action).toBe("upsert")
    expect(call.key).toBe(`${ORG}_knowledge_document_${DOC_ID}`)
  })

  it("tickets:message create enqueues an upsert of the PARENT ticket (message itself is not searchable)", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-7",
      event: {
        app: "tickets",
        entity: "message",
        action: "create",
        orgId: ORG,
        entityId: "msg-1",
        data: { ticketId: TICKET_ID },
      },
    })
    expect(recorded).toHaveLength(1)
    const call = recorded[0]!
    expect(call.payload.action).toBe("upsert")
    expect(call.payload).toMatchObject({
      action: "upsert",
      app: "tickets",
      entityType: "ticket",
      entityId: TICKET_ID,
    })
    expect(call.key).toBe(`${ORG}_tickets_ticket_${TICKET_ID}`)
  })

  it("tickets:message created (past-tense variant) is also accepted", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-7b",
      event: {
        app: "tickets",
        entity: "message",
        action: "created",
        orgId: ORG,
        entityId: "msg-2",
        data: { ticketId: TICKET_ID },
      },
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.payload).toMatchObject({
      entityType: "ticket",
      entityId: TICKET_ID,
    })
  })

  it("tickets:message create with no ticketId in the payload is dropped (no upsert)", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-7c",
      event: {
        app: "tickets",
        entity: "message",
        action: "create",
        orgId: ORG,
        entityId: "msg-3",
        data: {},
      },
    })
    expect(recorded).toEqual([])
  })

  it("kernel:contact update fans out to an upsert job PER ticket with that contact_id", async () => {
    const TICKET_A = "77777777-7777-7777-7777-777777777777"
    const TICKET_B = "88888888-8888-8888-8888-888888888888"
    currentContactFanoutRows = [{ id: TICKET_A }, { id: TICKET_B }]
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-8",
      event: {
        app: "kernel",
        entity: "contact",
        action: "update",
        orgId: ORG,
        entityId: "contact-1",
        data: { contactId: "contact-1" },
      },
    })
    expect(recorded).toHaveLength(2)
    const entityIds = recorded.map((c) => c.payload.entityId).sort()
    expect(entityIds).toEqual([TICKET_A, TICKET_B].sort())
    for (const call of recorded) {
      expect(call.payload).toMatchObject({ action: "upsert", app: "tickets", entityType: "ticket" })
    }
  })

  it("kernel:contact delete and merge fan out the same way as update", async () => {
    currentContactFanoutRows = [{ id: TICKET_ID }]
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    for (const action of ["delete", "merge"] as const) {
      recorded.length = 0
      await runDurableConsumers({
        eventId: `evt-9-${action}`,
        event: {
          app: "kernel",
          entity: "contact",
          action,
          orgId: ORG,
          entityId: "contact-2",
          data: { contactId: "contact-2" },
        },
      })
      expect(recorded).toHaveLength(1)
      expect(recorded[0]!.payload).toMatchObject({
        entityType: "ticket",
        entityId: TICKET_ID,
      })
    }
  })

  it("kernel:contact update with zero matching tickets enqueues nothing", async () => {
    currentContactFanoutRows = []
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-10",
      event: {
        app: "kernel",
        entity: "contact",
        action: "update",
        orgId: ORG,
        entityId: "contact-3",
        data: { contactId: "contact-3" },
      },
    })
    expect(recorded).toEqual([])
  })
})

describe("processIndexerJob", () => {
  it("upsert calls Meili addDocuments with a built document", async () => {
    const indexer = await loadIndexer()
    await indexer.processIndexerJob({
      action: "upsert",
      orgId: ORG,
      app: "tickets",
      entityType: "ticket",
      entityId: TICKET_ID,
    })
    expect(meiliAddDocuments).toHaveBeenCalledTimes(1)
    const docs = meiliAddDocuments.mock.calls[0][0]
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      id: `${ORG}_tickets_ticket_${TICKET_ID}`,
      app: "tickets",
      entity_type: "ticket",
      entity_id: TICKET_ID,
      org_id: ORG,
      title: "USB detection bug",
      body: "logs missing",
      read_scope: "tickets:tickets:read",
      team: "platform",
    })
    // Meili rejects a new unembedded document once any org declared the
    // memory embedder: the explicit opt-out keeps the ticket searchable.
    expect(docs[0]._vectors).toEqual({ memory: null })
  })

  it("delete calls Meili deleteDocument", async () => {
    const indexer = await loadIndexer()
    await indexer.processIndexerJob({
      action: "delete",
      orgId: ORG,
      app: "tickets",
      entityType: "ticket",
      entityId: TICKET_ID,
    })
    expect(meiliDeleteDocument).toHaveBeenCalledTimes(1)
    expect(meiliDeleteDocument.mock.calls[0][0]).toBe(`${ORG}_tickets_ticket_${TICKET_ID}`)
  })

  it("upsert for a projects task builds a document with its title (PRJ-2)", async () => {
    // Title substring search failed even with a correct event -> job pipeline
    // because the manifest's `task` entity declared no `indexFields`, so
    // buildSearchDocument never set doc.title. Repro string from the finding:
    // "Tessera Lab: Key of C triggers sound of A".
    currentReadRow = privilegedRows.task
    const indexer = await loadIndexer()
    await indexer.processIndexerJob({
      action: "upsert",
      orgId: ORG,
      app: "projects",
      entityType: "task",
      entityId: TASK_ID,
    })
    expect(meiliAddDocuments).toHaveBeenCalledTimes(1)
    const docs = meiliAddDocuments.mock.calls[0][0]
    expect(docs[0]).toMatchObject({
      entity_type: "task",
      entity_id: TASK_ID,
      title: "Tessera Lab: Key of C triggers sound of A",
    })
  })

  it("upsert for an unregistered entity is a no-op", async () => {
    const indexer = await loadIndexer()
    await indexer.processIndexerJob({
      action: "upsert",
      orgId: ORG,
      app: "ghost",
      entityType: "phantom",
      entityId: "x",
    })
    expect(meiliAddDocuments).not.toHaveBeenCalled()
  })
})

describe("processIndexerJob — generic ACL search primitive (aclFields)", () => {
  it("emits org_wide=false explicitly (must NOT be omitted like the dimension arrays)", async () => {
    currentReadRow = {
      id: DOC_ID,
      title: "Confidential doc",
      body: "body",
      org_wide: false,
      acl_user_ids: [],
      acl_role_ids: [],
    }
    const indexer = await loadIndexer()
    await indexer.processIndexerJob({
      action: "upsert",
      orgId: ORG,
      app: "knowledge",
      entityType: "document",
      entityId: DOC_ID,
    })
    const doc = meiliAddDocuments.mock.calls[0][0][0]
    expect(doc.org_wide).toBe(false)
  })

  it("emits acl_user_ids / acl_role_ids when non-empty, omits when empty", async () => {
    currentReadRow = {
      id: DOC_ID,
      title: "Confidential doc",
      body: "body",
      org_wide: false,
      acl_user_ids: ["u-1", "u-2"],
      acl_role_ids: [],
    }
    const indexer = await loadIndexer()
    await indexer.processIndexerJob({
      action: "upsert",
      orgId: ORG,
      app: "knowledge",
      entityType: "document",
      entityId: DOC_ID,
    })
    const doc = meiliAddDocuments.mock.calls[0][0][0]
    expect(doc.acl_user_ids).toEqual(["u-1", "u-2"])
    expect(doc.acl_role_ids).toBeUndefined()
  })

  it("emits org_wide=true for an org-wide readable document", async () => {
    currentReadRow = {
      id: DOC_ID,
      title: "Org-wide doc",
      body: "body",
      org_wide: true,
      acl_user_ids: ["owner-1"],
      acl_role_ids: ["role-a"],
    }
    const indexer = await loadIndexer()
    await indexer.processIndexerJob({
      action: "upsert",
      orgId: ORG,
      app: "knowledge",
      entityType: "document",
      entityId: DOC_ID,
    })
    const doc = meiliAddDocuments.mock.calls[0][0][0]
    expect(doc.org_wide).toBe(true)
    expect(doc.acl_user_ids).toEqual(["owner-1"])
    expect(doc.acl_role_ids).toEqual(["role-a"])
  })
})

describe("processIndexerJob — indexFilter (kernel user status)", () => {
  const USER_ID = "99999999-9999-9999-9999-999999999999"

  it("indexes an active user normally", async () => {
    currentReadRow = { id: USER_ID, name: "Alice", email: "alice@example.com", status: "active" }
    const indexer = await loadIndexer()
    await indexer.processIndexerJob({
      action: "upsert",
      orgId: ORG,
      app: "kernel",
      entityType: "user",
      entityId: USER_ID,
    })
    expect(meiliAddDocuments).toHaveBeenCalledTimes(1)
    expect(meiliAddDocuments.mock.calls[0][0][0]).toMatchObject({
      entity_type: "user",
      title: "Alice",
    })
  })

  it("treats a deactivated user upsert as a document delete", async () => {
    currentReadRow = {
      id: USER_ID,
      name: "Deactivated User",
      email: "slack-import+ghost@import.invalid",
      status: "deactivated",
    }
    const indexer = await loadIndexer()
    await indexer.processIndexerJob({
      action: "upsert",
      orgId: ORG,
      app: "kernel",
      entityType: "user",
      entityId: USER_ID,
    })
    expect(meiliAddDocuments).not.toHaveBeenCalled()
    expect(meiliDeleteDocument).toHaveBeenCalledTimes(1)
    expect(meiliDeleteDocument.mock.calls[0][0]).toBe(`${ORG}_kernel_user_${USER_ID}`)
  })

  it("treats a suspended user upsert as a document delete", async () => {
    currentReadRow = { id: USER_ID, name: "Bob", email: "bob@example.com", status: "suspended" }
    const indexer = await loadIndexer()
    await indexer.processIndexerJob({
      action: "upsert",
      orgId: ORG,
      app: "kernel",
      entityType: "user",
      entityId: USER_ID,
    })
    expect(meiliAddDocuments).not.toHaveBeenCalled()
    expect(meiliDeleteDocument).toHaveBeenCalledTimes(1)
  })

  it("kernel:user deactivate and reactivate events enqueue an upsert job", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    for (const action of ["deactivate", "reactivate"] as const) {
      recorded.length = 0
      await runDurableConsumers({
        eventId: `evt-user-${action}`,
        event: {
          app: "kernel",
          entity: "user",
          action,
          orgId: ORG,
          entityId: USER_ID,
          data: {},
        },
      })
      expect(recorded).toHaveLength(1)
      expect(recorded[0]!.payload).toMatchObject({
        action: "upsert",
        app: "kernel",
        entityType: "user",
        entityId: USER_ID,
      })
    }
  })
})

describe("waitForMeiliTask", () => {
  it("waits well past the client's 5 s default and polls", async () => {
    const { waitForMeiliTask, MEILI_TASK_WAIT_MS } = await loadIndexer()
    const waitForTask = mock(async () => ({ status: "succeeded" }))
    await waitForMeiliTask({ tasks: { waitForTask } }, 42)
    const [uid, opts] = waitForTask.mock.calls[0] as unknown as [number, { timeout: number }]
    expect(uid).toBe(42)
    expect(opts.timeout).toBe(MEILI_TASK_WAIT_MS)
    expect(MEILI_TASK_WAIT_MS).toBeGreaterThanOrEqual(5 * 60_000)
  })

  it("throws when Meili failed the task", async () => {
    const { waitForMeiliTask } = await loadIndexer()
    const waitForTask = mock(async () => ({ status: "failed", error: { message: "boom" } }))
    await expect(waitForMeiliTask({ tasks: { waitForTask } }, 7)).rejects.toThrow(
      "search task 7 failed: boom",
    )
  })
})

describe("live index jobs go through the coalescing queue", () => {
  it("the durable consumer records the change and enqueues NO app-kernel job", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-live-1",
      event: {
        app: "tickets",
        entity: "ticket",
        action: "update",
        orgId: ORG,
        entityId: TICKET_ID,
        data: {},
      } as any,
    })
    expect(enqueued).toEqual([])
    expect(meiliAddDocuments).not.toHaveBeenCalled()
    expect(recorded).toEqual([
      {
        t: "entity",
        key: `${ORG}_tickets_ticket_${TICKET_ID}`,
        payload: {
          action: "upsert",
          orgId: ORG,
          app: "tickets",
          entityType: "ticket",
          entityId: TICKET_ID,
        },
      },
    ])
  })

  it("a legacy search-index-upsert job already queued only records its request", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerJobWorkers()
    const upsert = registerJobWorkerMock.mock.calls.find((c) => c[1] === "search-index-upsert")?.[2]
    const del = registerJobWorkerMock.mock.calls.find((c) => c[1] === "search-index-delete")?.[2]
    const payload = { orgId: ORG, app: "tickets", entityType: "ticket", entityId: TICKET_ID }
    await upsert({ ...payload, action: "upsert" })
    await del({ ...payload, action: "delete" })
    expect(meiliAddDocuments).not.toHaveBeenCalled()
    expect(meiliDeleteDocument).not.toHaveBeenCalled()
    expect(enqueued).toEqual([])
    expect(recorded.map((r) => [r.key, r.payload.action])).toEqual([
      [`${ORG}_tickets_ticket_${TICKET_ID}`, "upsert"],
      [`${ORG}_tickets_ticket_${TICKET_ID}`, "delete"],
    ])
  })

  it("a leftover search-task-verify job is a no-op: no Meili call, no re-arm, no retry", async () => {
    const getTask = mock(async () => ({ status: "processing" }))
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue({
        index: () => ({ addDocuments: meiliAddDocuments, deleteDocument: meiliDeleteDocument }),
        tasks: { getTask },
      } as any),
    )
    const indexer = await loadIndexer()
    indexer.registerIndexerJobWorkers()
    const verify = registerJobWorkerMock.mock.calls.find((c) => c[1] === "search-task-verify")?.[2]
    expect(typeof verify).toBe("function")
    await verify({
      orgId: ORG,
      taskUid: 9,
      retry: { jobName: "search-index-upsert", payload: { orgId: ORG } },
      submittedAt: Date.now(),
      poll: 3,
    })
    expect(getTask).not.toHaveBeenCalled()
    expect(enqueued).toEqual([])
    expect(recorded).toEqual([])
  })

  it("registration adds the flush and sweep workers on their own queue, not app-kernel", async () => {
    const indexer = await loadIndexer()
    indexer.registerIndexerJobWorkers()
    const flush = registerJobWorkerMock.mock.calls.find((c) => c[1] === "search-index-flush")
    const sweep = registerJobWorkerMock.mock.calls.find((c) => c[1] === "search-index-sweep")
    expect(flush?.[0]).toBe("search-index")
    expect(flush?.[3]).toEqual({ concurrency: 1 })
    expect(sweep?.[0]).toBe("search-index")
  })

  it("the entity resolver builds the same document the direct path writes", async () => {
    const indexer = await loadIndexer()
    const payload = {
      action: "upsert" as const,
      orgId: ORG,
      app: "tickets",
      entityType: "ticket",
      entityId: TICKET_ID,
    }
    const plan = await indexer.planEntityDocument(payload)
    await indexer.processIndexerJob(payload)
    const written = meiliAddDocuments.mock.calls[0][0][0] as Record<string, unknown>
    expect(plan && "doc" in plan ? plan.doc.id : null).toBe(`${ORG}_tickets_ticket_${TICKET_ID}`)
    // The writer adds the vector opt-out; everything else is the plan's.
    expect({ ...(plan && "doc" in plan ? plan.doc : {}), _vectors: undefined }).toEqual({
      ...written,
      _vectors: undefined,
    })
    expect(written._vectors).toEqual({ memory: null })
  })
})
