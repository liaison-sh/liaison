// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from "bun:test"
import * as eventBus from "~/infra/events/event-bus"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { handleOpenApp } from "~/modules/agent/tools/navigation-tool"
import { entityRegistry, viewRegistry } from "~/modules/apps/app-registries"

const ctx = { userId: "u1", orgId: "o1" }
const ROUTINE_RUN = { routineId: "routine-1" }

describe("open_app navigation tool", () => {
  it("acknowledges the requested app (effect is client-side)", async () => {
    expect(await handleOpenApp({ app: "tickets" }, ctx)).toEqual({ ok: true, app: "tickets" })
  })

  it("passes through an optional view and trims input", async () => {
    expect(await handleOpenApp({ app: "  mail ", view: " inbox " }, ctx)).toEqual({
      ok: true,
      app: "mail",
      view: "inbox",
    })
  })

  it("omits view when not provided", async () => {
    const res = (await handleOpenApp({ app: "knowledge" }, ctx)) as Record<string, unknown>
    expect(res).toEqual({ ok: true, app: "knowledge" })
    expect("view" in res).toBe(false)
  })
})

describe("open_app to a view or a record", () => {
  const ORG = "org-open-app"
  const TASK = "11111111-1111-4111-8111-111111111111"
  /** A reader whose rows stand for what the actor's row security lets through. */
  function reader(rows: Array<Record<string, unknown>>) {
    const tx = {
      execute: async () => rows,
      select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
    }
    return { ...tx, transaction: async (fn: (t: unknown) => unknown) => fn(tx) }
  }
  const asPerson = (rows: Array<Record<string, unknown>>, scopes = ["*"]) => ({
    userId: "u1",
    orgId: ORG,
    db: reader(rows),
    scopes,
    agentExecutionThreadId: "thread-1",
  })
  const ROW = [{ label: "Fix the pump", handle: "task-7", present: true }]
  let broadcast: Mock<typeof eventBus.broadcastEphemeral>
  const frames = () => broadcast.mock.calls.map(([event]) => event)

  beforeEach(() => {
    broadcast = spyOn(eventBus, "broadcastEphemeral").mockResolvedValue(undefined)
    viewRegistry.set([ORG, "projects"], {
      tabTypes: {
        home: { label: "Projects", urlPattern: "/projects", singleton: true },
        task: { label: "Task", urlPattern: "/projects/tasks/:entityId" },
      },
    } as never)
    entityRegistry.set([ORG, "projects", "task"], {
      labelField: "title",
      handlePrefix: "task",
      tableName: "tasks",
      readScope: "projects:projects:read",
    } as never)
    viewRegistry.set([ORG, "shop"], {
      detail: {
        order: { externalLink: { urlTemplate: "https://{{shop}}.example/orders/{{id}}" } },
        customer: { component: "CustomerPanel" },
      },
    } as never)
    entityRegistry.set([ORG, "shop", "customer"], {
      labelField: "email",
      tableName: "customers",
      external: true,
      readScope: "shop:customers:read",
    } as never)
    entityRegistry.set([ORG, "shop", "order"], {
      labelField: "name",
      tableName: "orders",
      external: true,
      readScope: "shop:orders:read",
    } as never)
  })

  afterEach(() => {
    broadcast.mockRestore()
    viewRegistry.delete([ORG, "projects"])
    viewRegistry.delete([ORG, "shop"])
    entityRegistry.delete([ORG, "projects", "task"])
    entityRegistry.delete([ORG, "shop", "customer"])
    entityRegistry.delete([ORG, "shop", "order"])
  })

  it("a visible record opens its tab, named by the row", async () => {
    expect(await handleOpenApp({ app: "projects", view: "task", id: TASK }, asPerson(ROW))).toEqual(
      {
        ok: true,
        app: "projects",
        view: "task",
        id: TASK,
        label: "Fix the pump",
        tab: { type: "projects:task", entityId: TASK },
      },
    )
  })

  it("a hidden record answers NOT_FOUND, as one that does not exist", async () => {
    const res = await handleOpenApp({ app: "projects", view: "task", id: TASK }, asPerson([]))
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" })
    expect(frames()).toHaveLength(0)
    expect(res).toMatchObject({ message: expect.stringContaining("No tab opened") })
  })

  it("without the record's reading scope the row is not even read", async () => {
    const res = await handleOpenApp(
      { app: "projects", view: "task", id: TASK },
      asPerson(ROW, ["tickets:tickets:read"]),
    )
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("an unknown view is refused and names the valid ones", async () => {
    const res = await handleOpenApp({ app: "projects", view: "taks", id: TASK }, asPerson(ROW))
    expect(res).toMatchObject({ ok: false, code: "UNKNOWN_VIEW", valid: ["home", "task"] })
    expect(res).toMatchObject({ message: expect.stringContaining("task (Task, takes an id)") })
  })

  it("an id with no view opens the app's only kind of record", async () => {
    expect(await handleOpenApp({ app: "projects", id: TASK }, asPerson(ROW))).toMatchObject({
      ok: true,
      view: "task",
    })
  })

  it("a view that opens a record refuses to open without its id", async () => {
    expect(await handleOpenApp({ app: "projects", view: "task" }, asPerson(ROW))).toMatchObject({
      ok: false,
      code: "ID_REQUIRED",
    })
  })

  it("a view with no record opens on its own and refuses an id", async () => {
    expect(await handleOpenApp({ app: "projects", view: "home" }, asPerson(ROW))).toEqual({
      ok: true,
      app: "projects",
      view: "home",
      opened: "Projects",
    })
    expect(frames()[0]?.data).toMatchObject({ tab: { type: "projects:home", entityId: "home" } })
    expect(
      await handleOpenApp({ app: "projects", view: "home", id: TASK }, asPerson(ROW)),
    ).toMatchObject({ ok: false, code: "ID_NOT_TAKEN" })
  })

  it("an id for an app with no views is refused rather than acknowledged", async () => {
    expect(await handleOpenApp({ app: "nope", view: "x", id: TASK }, asPerson(ROW))).toMatchObject({
      ok: false,
      code: "UNKNOWN_APP",
    })
  })

  it("an id that could break out of the tab's route is refused unread", async () => {
    const res = await handleOpenApp(
      { app: "projects", view: "task", id: "../../settings?x=1" },
      asPerson(ROW),
    )
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("a read that fails counts as hidden and stays inside its savepoint", async () => {
    const db = {
      execute: async () => [],
      transaction: async () => {
        throw new Error("invalid input syntax for type uuid")
      },
    }
    const res = await handleOpenApp(
      { app: "projects", view: "task", id: "not-a-uuid" },
      { userId: "u1", orgId: ORG, db, scopes: ["*"] },
    )
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("a panel opens in the detail tab, with its id encoded", async () => {
    const gid = "gid://shop/Customer/9"
    const res = await handleOpenApp(
      { app: "shop", view: "customer", id: gid },
      asPerson([{ label: "ada@example.com", present: true }]),
    )
    expect(res).toMatchObject({ ok: true, opened: `customer ${gid}` })
    expect(JSON.stringify(res)).not.toContain("ada@example.com")
    expect(frames()[0]?.data).toMatchObject({
      label: "ada@example.com",
      tab: { type: "kernel:detail", entityId: `shop/customer/${encodeURIComponent(gid)}` },
    })
  })

  it("a record held only in another system opens unchecked, and says so", async () => {
    const res = await handleOpenApp(
      { app: "shop", view: "customer", id: "c9" },
      asPerson([{ present: false }]),
    )
    expect(res).toMatchObject({ ok: true, note: expect.stringContaining("not checked") })
    expect(frames()[0]?.data).toMatchObject({
      tab: { type: "kernel:detail", entityId: "shop/customer/c9" },
    })
  })

  it("a record held only in another system still needs its reading scope", async () => {
    const res = await handleOpenApp(
      { app: "shop", view: "customer", id: "c9" },
      asPerson([{ present: false }], ["projects:projects:read"]),
    )
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("a record whose only page is elsewhere opens no tab, and says so", async () => {
    const res = await handleOpenApp(
      { app: "shop", view: "order", id: "o9" },
      asPerson([{ present: false }]),
    )
    expect(res).toMatchObject({ ok: false, code: "OPENS_OUTSIDE" })
    expect(frames()).toHaveLength(0)
  })

  it("a routine's run has no viewer: it opens nothing and says so, even with only an app", async () => {
    await runContextStore.run(ROUTINE_RUN as never, async () => {
      expect(await handleOpenApp({ app: "projects" }, asPerson(ROW))).toMatchObject({
        ok: false,
        code: "NO_VIEWER",
      })
      expect(
        await handleOpenApp({ app: "projects", view: "task", id: TASK }, asPerson(ROW)),
      ).toMatchObject({ ok: false, code: "NO_VIEWER" })
    })
  })
})
