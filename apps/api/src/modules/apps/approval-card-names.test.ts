// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN APPROVAL CARD NAMES WHAT ITS READER READS. A tool with no summarizer of its own can be held for
// a decision too (a turn that read scoped data), and its card is then made from its params. A bare
// id never reaches the card, and neither does a record's name until someone who may read that
// record reads the card.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ApprovalSummary } from "@liaison/shared"
import {
  type DealWorld,
  makeDealWorld,
  makeTask,
  makeWorkProject,
} from "~/apps/projects/service/__tests__/deal-world"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { UUID_RE } from "~/lib/uuid"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { entityRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { recordWords, withoutNames, withViewerNames } from "~/modules/apps/approval-record-names"
import { recordToken } from "~/modules/apps/approval-record-token"
import {
  generateApprovalSummary,
  genericApprovalSummary,
  registerApprovalSummarizer,
  templateApprovalSummarizer,
} from "~/modules/apps/approval-summarizers"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"
import * as referenceDisplay from "~/modules/threads/reference-display"
import { insertSql } from "~/seed/factories/org/test-rows"
import { createTestCompany } from "~/tests/helpers/company"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO = resolve(import.meta.dir, "../../../../..")
const ANY_UUID = new RegExp(UUID_RE.source.replace(/^\^|\$$/g, ""), "i")
const ID = "6c1bffa3-edf4-4e2f-b1d2-6ff36ba0a708"
const OTHER_ID = "532feb94-554f-434c-9542-ccffc7007e47"

interface Tool {
  name: string
  params: Record<string, { type?: unknown }>
  template?: string
}

/** Every tool the apps of this checkout declare. */
function catalog(): Tool[] {
  const out: Tool[] = []
  for (const root of [join(REPO, "apps/api/src/apps"), join(REPO, "bundled-apps")]) {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, "app.manifest.json")
      if (!existsSync(file)) continue
      const m = JSON.parse(readFileSync(file, "utf8")) as {
        name: string
        tools?: Record<
          string,
          { params?: { properties?: Tool["params"] }; approvalCard?: { summary?: string } }
        >
      }
      for (const [tool, def] of Object.entries(m.tools ?? {})) {
        out.push({
          name: `${m.name}:${tool}`,
          params: def.params?.properties ?? {},
          ...(def.approvalCard?.summary ? { template: def.approvalCard.summary } : {}),
        })
      }
    }
  }
  return out
}

/** A call of the tool whose every text and list holds a uuid: the worst its card can be given. */
function idCall(params: Tool["params"]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([key, def]) => {
      const type = Array.isArray(def.type) ? def.type[0] : def.type
      if (type === "array") return [key, [ID, OTHER_ID]]
      if (type === "object") return [key, { id: ID, nested: { recordId: OTHER_ID, note: ID } }]
      if (type === "boolean") return [key, true]
      if (type === "integer" || type === "number") return [key, 3]
      return [key, ID]
    }),
  )
}

describe("a card made from a call's params, over the whole catalog", () => {
  const tools = catalog()

  it("finds the catalog", () => {
    expect(tools.length).toBeGreaterThan(300)
    expect(tools.some((t) => t.name === "projects:deals_update")).toBe(true)
  })

  it("shows no bare id, in any tool's title, subtitle or lines", async () => {
    const shown: string[] = []
    for (const t of tools) {
      const params = idCall(t.params)
      const cards = [genericApprovalSummary(t.name, params)]
      if (t.template) {
        cards.push(await templateApprovalSummarizer(t.template, t.name)(params, {} as never))
      }
      for (const c of cards) {
        const text = [c.title, c.subtitle ?? "", ...c.lines].join("\n")
        if (ANY_UUID.test(text)) shown.push(`${t.name}: ${text}`)
        if (c.title.trim() === "") shown.push(`${t.name}: no title`)
      }
    }
    expect(shown).toEqual([])
  })

  it("still shows everything that is not an id", () => {
    const card = genericApprovalSummary("projects:deals_update", {
      taskId: ID,
      outcome: "won",
      probability: 40,
      nextStep: "Call on Monday",
    })
    expect(card.lines).toEqual([
      "Task: a record",
      "Outcome: won",
      "Probability: 40",
      "Next step: Call on Monday",
    ])
  })

  it("shows no id inside a longer text either", async () => {
    const card = genericApprovalSummary("projects:comment", {
      body: `Same as ${ID}, see there`,
      items: { deep: { deeper: { ref: ID } } },
    })
    expect(card.lines).toEqual(["Body: Same as …, see there", 'Items, deep, deeper: {"ref":"…"}'])
    // A token naming an earlier step is read by the step, later (modules/apps/execute-tool.ts).
    const token = `@ref:${ID}:draft_id`
    expect(genericApprovalSummary("mail:reply", { body: token }).lines).toEqual([`Body: ${token}`])
    const merge = await templateApprovalSummarizer("Merge {{params.ids}}", "tickets:merge")(
      { ids: [ID, OTHER_ID] },
      {} as never,
    )
    expect(merge.title).toBe("Merge 2 items")
  })

  it("keeps every field of ids nothing names: a card hides nothing of what it decides", () => {
    const lines = (tool: string, params: unknown) => genericApprovalSummary(tool, params).lines
    expect(lines("projects:move", { taskId: ID, statusId: OTHER_ID })).toEqual([
      "Task: a record",
      "Status: a record",
    ])
    expect(lines("tickets:setCategory", { ticketId: ID, categoryId: OTHER_ID })).toEqual([
      "Ticket: a record",
      "Category: a record",
    ])
    expect(
      lines("kernel:contacts_share", { contactId: ID, roleId: OTHER_ID, access: "editor" }),
    ).toEqual(["Contact: a record", "Role: a record", "Access: editor"])
  })

  it("says how many records a list of ids names", () => {
    expect(
      genericApprovalSummary("tickets:merge", { sourceTicketIds: [ID, OTHER_ID] }).lines,
    ).toEqual(["Source ticket: 2 items"])
  })
})

describe("the words of an id's parameter", () => {
  it("drop the id suffix and keep the rest", () => {
    expect(recordWords("parentTaskIds")).toEqual(["parent", "task"])
    expect(recordWords("project_id")).toEqual(["project"])
    expect(recordWords("id")).toEqual([])
  })
})

describe("the records a call names", () => {
  let w: DealWorld
  let project = ""
  let task = ""
  let company = ""
  let closedCompany = ""
  const ALL = [
    "projects:projects:read",
    "kernel:companies:read",
    "kernel:contacts:read",
    "knowledge:documents:read",
  ]

  /** The card as it is stored, made as whoever asked. */
  const stored = (tool: string, params: unknown) =>
    withRlsContext({ ...w.actor, scopes: ["*"] }, (tx) => {
      const [app, name] = tool.split(":") as [string, string]
      return generateApprovalSummary(
        w.orgId,
        app,
        name,
        params,
        { tx, orgId: w.orgId, userId: w.userId, actor: w.actor },
        tool,
      )
    })

  /** The stored card as a person holding `scopes` reads it. */
  const readBy = (card: ApprovalSummary, scopes: string[], userId = w.userId) =>
    withRlsContext(
      { actorType: "user", userId, orgId: w.orgId, scopes, dimensionGrants: {} },
      async (tx) => {
        const [row] = await withViewerNames(tx, w.orgId, [{ summary: card }])
        return row?.summary as ApprovalSummary
      },
    )

  const read = async (tool: string, params: unknown, scopes = ALL) =>
    readBy(await stored(tool, params), scopes)

  const entity = (labelField: string, tableName: string, readScope?: string) =>
    ({ labelField, handlePrefix: "x", tableName, ...(readScope ? { readScope } : {}) }) as never

  async function document(title: string, orgAccess: string) {
    const id = crypto.randomUUID()
    await sql.unsafe(
      insertSql("app_knowledge.documents", {
        id,
        org_id: w.orgId,
        title,
        body: "body",
        document_scope: "organization",
        owner_user_id: w.userId,
        created_by: w.userId,
        revision: 1,
        required_scopes: "{}",
        sensitivity: "internal",
        org_access: orgAccess,
      }),
    )
    return id
  }

  async function contact(name: string | null, orgAccess: string) {
    const id = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.contacts", {
        id,
        org_id: w.orgId,
        name,
        email: `${id.slice(0, 8)}@example.com`,
        handle: `c-${id.slice(0, 8)}`,
        org_access: orgAccess,
        created_by: w.userId,
        owner_user_id: w.userId,
      }),
    )
    return id
  }

  beforeAll(async () => {
    await acquireTestLock()
    w = await makeDealWorld("card-names")
    entityRegistry.set(
      [w.orgId, "projects", "project"],
      entity("name", "projects", "projects:projects:read"),
    )
    entityRegistry.set(
      [w.orgId, "projects", "task"],
      entity("title", "tasks", "projects:projects:read"),
    )
    // Where its name would be is not a table at all: the next kind is read.
    entityRegistry.set([w.orgId, "projects", "ghost"], entity("name", "no_such_table"))
    entityRegistry.set([w.orgId, "mail", "conversation"], entity("subject", "conversations"))
    entityRegistry.set(
      [w.orgId, "knowledge", "document"],
      entity("title", "documents", "knowledge:documents:read"),
    )
    project = (await makeWorkProject(w, "Client portal")).projectId
    task = await makeTask(w, project, "Supplier   portal rebuild")
    company = await createTestCompany(w.orgId, "Northwind Cooperative")
    closedCompany = await createTestCompany(w.orgId, "Quiet Holdings")
    await sql`UPDATE kernel.companies SET org_access = 'none', created_by = ${w.userId}
               WHERE id = ${closedCompany}`
    await sql`UPDATE kernel.users SET name = 'Fixture Person' WHERE id = ${w.userId}`
  }, 120_000)

  afterAll(async () => {
    entityRegistry.deleteByPrefix([w.orgId])
    toolRegistry.deleteByPrefix([w.orgId])
    await releaseTestLock()
  })

  const MOVE = () => ({ taskId: task, projectId: project, assigneeId: w.userId, note: "soon" })
  const NAMED = [
    "Task: Supplier portal rebuild",
    "Project: Client portal",
    "Assignee: Fixture Person",
    "Note: soon",
  ]

  it("are stored by what kind they are, never by name", async () => {
    const card = await stored("projects:move", MOVE())
    expect(card.title).toBe("Projects: move")
    expect(card.lines).toEqual([
      "Task: a task",
      "Project: a project",
      "Assignee: a person",
      "Note: soon",
    ])
    const text = JSON.stringify(card)
    for (const name of ["Supplier", "Client portal", "Fixture Person"]) {
      expect(text).not.toContain(name)
    }
    // Nor does what is sent to many readers at once say more than the stored words.
    expect(JSON.stringify(withoutNames(card))).not.toContain(task)
  })

  it("are read by their names by who may read them, and the one acted on is in the title", async () => {
    const card = await read("projects:move", MOVE())
    expect(card.title).toBe("Projects: move: Supplier portal rebuild")
    expect(card.lines).toEqual(NAMED)
    expect(card.names).toBeUndefined()
  })

  it("stay unnamed to a decider who may not read them", async () => {
    const card = await read("projects:move", MOVE(), ["projects:approve"])
    expect(card.title).toBe("Projects: move")
    expect(card.lines).toEqual([
      "Task: a task",
      "Project: a project",
      "Assignee: Fixture Person",
      "Note: soon",
    ])
    expect(card.names).toBeUndefined()
  })

  it("are judged one by one: a reader of some reads those", async () => {
    const params = { taskId: task, companyId: company, contactId: await contact("Ada", "viewer") }
    const lines = async (scopes: string[]) =>
      (await read("invoicing:billing_step_add", params, scopes)).lines
    expect(await lines(ALL)).toEqual([
      "Task: Supplier portal rebuild",
      "Company: Northwind Cooperative",
      "Contact: Ada",
    ])
    expect(await lines(["invoicing:approve"])).toEqual([
      "Task: a task",
      "Company: a company",
      "Contact: a contact",
    ])
    expect(await lines(["kernel:companies:read"])).toEqual([
      "Task: a task",
      "Company: Northwind Cooperative",
      "Contact: a contact",
    ])
    expect(await lines(["kernel:contacts:read"])).toEqual([
      "Task: a task",
      "Company: a company",
      "Contact: Ada",
    ])
  })

  for (const tool of [
    "invoicing:billing_plan_set",
    "invoicing:advance_draft_create",
    "invoicing:retainer_terms_renew",
    "agreements:agreement_create",
    "calls:calls_set_links",
  ]) {
    it(`${tool} names another app's record only to who may read it`, async () => {
      const card = await stored(tool, { taskId: task })
      expect(card.title).not.toContain("Supplier")
      expect(card.lines).toEqual(["Task: a task"])
      // The scope that decides it is not one that reads the record.
      const decider = await readBy(card, [`${tool.split(":")[0]}:approve`])
      expect(JSON.stringify(decider)).not.toContain("Supplier")
      const reader = await readBy(card, ALL)
      // Its title is of its own app's records: another's stays in its line.
      expect(reader.title).toBe(card.title)
      expect(reader.lines).toEqual(["Task: Supplier portal rebuild"])
    })
  }

  it("a kind's read scope is asked even where its rows would be readable", async () => {
    entityRegistry.set(
      [w.orgId, "projects", "gadget"],
      entity("title", "tasks", "projects:gadgets:read"),
    )
    const card = await stored("projects:gadget_move", { gadgetId: task })
    expect((await readBy(card, ["projects:projects:read"])).lines).toEqual(["Gadget: a gadget"])
    expect((await readBy(card, ["projects:projects:read", "projects:gadgets:read"])).lines).toEqual(
      ["Gadget: Supplier portal rebuild"],
    )
    entityRegistry.delete([w.orgId, "projects", "gadget"])
  })

  it("a kind that says nothing of who reads it is named to nobody", async () => {
    entityRegistry.set([w.orgId, "projects", "note"], entity("title", "tasks"))
    expect((await read("projects:note_move", { noteId: task }, ["*"])).lines).toEqual([
      "Note: a note",
    ])
    entityRegistry.delete([w.orgId, "projects", "note"])
  })

  it("an app that is not the reader's names nothing", async () => {
    const card = await stored("projects:move", { taskId: task })
    rememberOrgAppStates(w.orgId, [
      {
        app: "projects",
        status: "active",
        accessMode: "restricted",
        allowedUserIds: new Set<string>(),
      },
    ])
    try {
      expect((await readBy(card, ["*"])).lines).toEqual(["Task: a task"])
    } finally {
      forgetOrgApps(w.orgId)
    }
    expect((await readBy(card, ["*"])).lines).toEqual(["Task: Supplier portal rebuild"])
  })

  it("a read with nobody's access behind it names nothing", async () => {
    const card = await stored("projects:move", MOVE())
    const [row] = await withPrivilegedDb(w.orgId, "test-card-names", (tx) =>
      withViewerNames(tx as never, w.orgId, [{ summary: card }]),
    )
    expect(row?.summary.title).toBe("Projects: move")
    // Not even a colleague's, which every person may read.
    expect(row?.summary.lines.slice(0, 3)).toEqual([
      "Task: a task",
      "Project: a project",
      "Assignee: a person",
    ])
    expect(row?.summary.names).toBeUndefined()
  })

  it("an agent's run names nothing: what it reads may be posted to people who read less", async () => {
    const card = await stored("projects:move", MOVE())
    const seen = await runContextStore.run({} as never, () => readBy(card, ALL))
    expect(seen.lines[0]).toBe("Task: a task")
    expect(seen.names).toBeUndefined()
  })

  it("every card of a feed is named in one query per kind of record", async () => {
    const cards = await Promise.all(
      Array.from({ length: 12 }, (_, i) => stored("projects:move", { ...MOVE(), note: `n${i}` })),
    )
    const reads = { n: 0 }
    const rows = await withRlsContext({ ...w.actor, scopes: ALL }, (tx) => {
      const counted = (t: typeof tx): typeof tx =>
        new Proxy(t, {
          get(target, prop) {
            const value = Reflect.get(target, prop)
            if (typeof value !== "function") return value
            if (prop === "transaction") {
              return (fn: (sp: typeof tx) => unknown) =>
                value.call(target, (sp: typeof tx) => fn(counted(sp)))
            }
            if (prop === "execute" || prop === "select") reads.n++
            return value.bind(target)
          },
        })
      return withViewerNames(
        counted(tx),
        w.orgId,
        cards.map((summary) => ({ summary })),
      )
    })
    expect(rows.map((r) => r.summary.lines.slice(0, 3))).toEqual(
      Array.from({ length: 12 }, () => NAMED.slice(0, 3)),
    )
    // Who reads, and one for tasks, projects and people each.
    expect(reads.n).toBe(4)
  })

  it("a text changed since the card was made keeps its stored words", async () => {
    const card = await stored("projects:move", { taskId: task, projectId: project })
    const edited = { ...card, title: "Moved by hand", lines: [card.lines[1] ?? "", "Added"] }
    const seen = await readBy(edited, ALL)
    expect(seen.title).toBe("Moved by hand")
    expect(seen.lines).toEqual(["Project: Client portal", "Added"])
  })

  it("two fields that read the same are each their own record", async () => {
    const second = await makeTask(w, project, "Second task")
    const card = await read("projects:link", { taskId: task, otherTaskId: second })
    expect(card.lines).toEqual(["Task: Supplier portal rebuild", "Other task: Second task"])
    const parts = await read("projects:link", { a: { taskId: task }, b: { taskId: second } })
    expect(parts.lines).toEqual(["A, task: Supplier portal rebuild", "B, task: Second task"])
    registerApprovalSummarizer(w.orgId, "projects", "pair", async () => ({
      kind: "projects.pair",
      title: "Link two tasks",
      lines: [task, second].map((id) => `Task: ${id}`),
    }))
    const pair = await read("projects:pair", { taskIds: [task, second] })
    expect(pair.lines).toEqual(["Task: Supplier portal rebuild", "Task: Second task"])
  })

  it("a caller's words cannot pass for a record", async () => {
    const forged = recordToken({ app: "projects", entityType: "task", id: task })
    const card = await stored("projects:comment", { body: `See ${forged}` })
    expect(card.names).toBeUndefined()
    expect(card.lines[0]).toStartWith("Body: See projects:task:")
  })

  it("a new record is titled by its own name, not by where it goes", async () => {
    const card = await read("projects:create", { projectId: project, title: "Fix the login" })
    expect(card.title).toBe("Projects: create: Fix the login")
    expect(card.lines).toEqual(["Project: Client portal", "Title: Fix the login"])
  })

  it("an `id` is the record the tool acts on, of its app, and is what the title names", async () => {
    const card = await read("projects:archive_thing", { id: task })
    expect(card.title).toBe("Projects: archive thing: Supplier portal rebuild")
    expect(card.lines).toEqual(["Task: Supplier portal rebuild"])
    const second = await makeTask(w, project, "Parent task")
    const both = await read("projects:archive_thing", { parentTaskId: second, id: task })
    expect(both.title).toBe("Projects: archive thing: Supplier portal rebuild")
  })

  it("the app's own kind comes before another app's of the same word", async () => {
    // One id, a record of both apps: each app's tool means its own.
    entityRegistry.set(
      [w.orgId, "knowledge", "document"],
      entity("title", "documents", "knowledge:documents:read"),
    )
    entityRegistry.set(
      [w.orgId, "projects", "document"],
      entity("title", "tasks", "projects:projects:read"),
    )
    const both = await document("Same id", "viewer")
    await sql`UPDATE app_knowledge.documents SET id = ${task} WHERE id = ${both}`
    const kindOf = async (tool: string) =>
      (await stored(tool, { documentId: task })).names?.map((n) => n.named).join()
    const [own, other] = [await kindOf("projects:move"), await kindOf("knowledge:move")]
    entityRegistry.delete([w.orgId, "projects", "document"])
    await sql`UPDATE app_knowledge.documents SET id = ${both} WHERE id = ${task}`
    expect(own).toContain("projects:document:")
    expect(other).toContain("knowledge:document:")
  })

  it("a list reads as names", async () => {
    const card = await read("projects:bulk_touch", { taskIds: [task, OTHER_ID] })
    expect(card.lines).toEqual(["Task: Supplier portal rebuild and 1 more"])
  })

  it("no more records are looked up for one card than a card can need", async () => {
    const lookups = spyOn(referenceDisplay, "resolveEntityLabel")
    try {
      const ids = Array.from({ length: 40 }, () => crypto.randomUUID())
      await stored("projects:bulk_touch", { taskIds: [...ids, task] })
      expect(new Set(lookups.mock.calls.map(([, at]) => at.entityId)).size).toBe(12)
    } finally {
      lookups.mockRestore()
    }
  })

  it("a company or contact shared by name is named to nobody on a card", async () => {
    const card = await read("projects:link_client", { companyId: closedCompany }, ["*"])
    expect(card.lines).toEqual(["Company: a company"])
    expect((await read("projects:link_client", { companyId: company })).lines).toEqual([
      "Company: Northwind Cooperative",
    ])
    const quiet = await contact("Quiet Person", "none")
    expect((await read("projects:link_person", { contactId: quiet }, ["*"])).lines).toEqual([
      "Contact: a contact",
    ])
  })

  it("a record with no name of its own says so, and is not called restricted", async () => {
    const nameless = await contact(null, "viewer")
    expect((await read("projects:link_person", { contactId: nameless })).lines).toEqual([
      "Contact: a contact with no name",
    ])
    expect(
      (await read("projects:link_person", { contactId: nameless }, ["projects:approve"])).lines,
    ).toEqual(["Contact: a contact"])
  })

  it("a document closed to the organization is not named, an open one is", async () => {
    const open = await read("projects:attach", {
      documentId: await document("Onboarding guide", "viewer"),
    })
    expect(open.lines).toEqual(["Document: Onboarding guide"])
    const closed = await stored("projects:attach", {
      documentId: await document("Board minutes", "none"),
    })
    for (const scopes of [ALL, ["*"]]) {
      const seen = await readBy(closed, scopes)
      expect(seen.lines).toEqual(["Document: a document"])
      expect(JSON.stringify(seen)).not.toContain("Board minutes")
    }
  })

  it("a kind that can be closed, whose table or closing cannot be read, is named to nobody", async () => {
    const id = await document("Onboarding guide", "viewer")
    const card = await stored("projects:attach", { documentId: id })
    // No table at all, then a table that does not say whether the record is closed.
    for (const decl of [
      { labelField: "title", handlePrefix: "doc", readScope: "knowledge:documents:read" },
      {
        labelField: "title",
        handlePrefix: "doc",
        tableName: "source_links",
        readScope: "knowledge:documents:read",
      },
    ]) {
      entityRegistry.set([w.orgId, "knowledge", "document"], decl as never)
      expect((await readBy(card, ["*"])).lines).toEqual(["Document: a document"])
    }
    entityRegistry.set(
      [w.orgId, "knowledge", "document"],
      entity("title", "documents", "knowledge:documents:read"),
    )
    expect((await readBy(card, ALL)).lines).toEqual(["Document: Onboarding guide"])
  })

  it("an id nobody can name is a record, and the caller's transaction goes on", async () => {
    const card = await read("projects:touch_ghost", { ghostId: task, templateId: OTHER_ID, n: 1 })
    expect(card.title).toBe("Projects: touch ghost")
    expect(card.lines).toEqual(["Ghost: a record", "Template: a record", "N: 1"])
  })

  it("one unnamed id never hides the rest of its field", async () => {
    const card = await read("projects:move", { taskId: task, statusId: OTHER_ID })
    expect(card.lines).toEqual(["Task: Supplier portal rebuild", "Status: a record"])
  })

  it("a part of a record that can be closed is never looked up", async () => {
    entityRegistry.set(
      [w.orgId, "agreements", "agreement_version"],
      entity("number", "agreement_versions"),
    )
    const lookups = spyOn(referenceDisplay, "resolveEntityLabel")
    try {
      await stored("projects:attach", { agreementVersionId: OTHER_ID })
      expect(lookups.mock.calls.map(([, at]) => at.app)).not.toContain("agreements")
    } finally {
      lookups.mockRestore()
    }
  })

  it("what may be one person's own is never looked up, nor named", async () => {
    const mail = { tool: "mail:archive", params: { conversationId: task } }
    entityRegistry.set(
      [w.orgId, "projects", "conversation"],
      entity("title", "tasks", "projects:projects:read"),
    )
    // A kind of the same name in an app whose records are the organization's is read.
    expect((await read(mail.tool, mail.params)).lines).toEqual([
      "Conversation: Supplier portal rebuild",
    ])
    entityRegistry.delete([w.orgId, "projects", "conversation"])
    const lookups = spyOn(referenceDisplay, "resolveEntityLabel")
    try {
      expect((await read(mail.tool, mail.params)).lines).toEqual(["Conversation: a record"])
      expect(lookups.mock.calls.map(([, at]) => `${at.app}:${at.entityType}`)).not.toContain(
        "mail:conversation",
      )
    } finally {
      lookups.mockRestore()
    }
  })

  it("an approvalCard template reads names too", async () => {
    registerApprovalSummarizer(
      w.orgId,
      "projects",
      "merge_into",
      templateApprovalSummarizer("Merge into {{params.taskId}}", "projects:merge_into"),
    )
    const card = await stored("projects:merge_into", { taskId: task })
    expect(card.title).toBe("Merge into a task")
    expect((await readBy(card, ALL)).title).toBe("Merge into Supplier portal rebuild")
  })

  it("a summarizer's own words keep an id only when nothing names it, and its records stand", async () => {
    registerApprovalSummarizer(w.orgId, "projects", "spoken", async () => ({
      kind: "projects.spoken",
      title: `Move ${task}`,
      subtitle: recordToken({ app: "projects", entityType: "project", id: project }),
      lines: [`From ${OTHER_ID}`],
    }))
    const card = await stored("projects:spoken", { taskId: task, sourceId: OTHER_ID })
    expect(card.title).toBe("Move a task")
    expect(card.subtitle).toBe("Pending approval")
    expect(card.lines).toEqual([`From ${OTHER_ID}`])
    const seen = await readBy(card, ALL)
    expect(seen.title).toBe("Move Supplier portal rebuild")
    expect(seen.subtitle).toBe("Client portal")
  })
})
