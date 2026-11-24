// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN APPROVAL CARD NAMES WHAT A PERSON READS. A tool with no summarizer of its own can be held for
// a decision too (a turn that read scoped data), and its card is then made from its params: the
// records they name by id read by their names, and a bare id never reaches the card.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  type DealWorld,
  makeDealWorld,
  makeTask,
  makeWorkProject,
} from "~/apps/projects/service/__tests__/deal-world"
import { sql } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { UUID_RE } from "~/lib/uuid"
import { entityRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { recordWords } from "~/modules/apps/approval-record-names"
import {
  generateApprovalSummary,
  genericApprovalSummary,
  templateApprovalSummarizer,
} from "~/modules/apps/approval-summarizers"
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
    expect(card.lines).toEqual(["Outcome: won", "Probability: 40", "Next step: Call on Monday"])
  })

  it("shows no id inside a longer text either", async () => {
    const card = genericApprovalSummary("projects:comment", {
      body: `Same as ${ID}, see there`,
      items: { deep: { deeper: { ref: ID } } },
    })
    expect(card.lines).toEqual(["Body: Same as …, see there", 'Items, deep, deeper: {"ref":"…"}'])
    const merge = await templateApprovalSummarizer("Merge {{params.ids}}", "tickets:merge")(
      { ids: [ID, OTHER_ID] },
      {} as never,
    )
    expect(merge.title).toBe("Merge 2 items")
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

  const summary = (tool: string, params: unknown) =>
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

  beforeAll(async () => {
    await acquireTestLock()
    w = await makeDealWorld("card-names")
    const entity = (labelField: string, tableName: string) =>
      ({ labelField, handlePrefix: "x", tableName }) as never
    entityRegistry.set([w.orgId, "projects", "project"], entity("name", "projects"))
    entityRegistry.set([w.orgId, "projects", "task"], entity("title", "tasks"))
    // Where its name would be is not a table at all: the next kind is read.
    entityRegistry.set([w.orgId, "projects", "ghost"], entity("name", "no_such_table"))
    entityRegistry.set([w.orgId, "mail", "conversation"], entity("subject", "conversations"))
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

  it("are read by their names, and the one acted on is in the title", async () => {
    const card = await summary("projects:move", {
      taskId: task,
      projectId: project,
      assigneeId: w.userId,
      note: "soon",
    })
    expect(card.title).toBe("Projects: move: Supplier portal rebuild")
    expect(card.lines).toEqual([
      "Task: Supplier portal rebuild",
      "Project: Client portal",
      "Assignee: Fixture Person",
      "Note: soon",
    ])
  })

  it("a new record is titled by its own name, not by where it goes", async () => {
    const card = await summary("projects:create", { projectId: project, title: "Fix the login" })
    expect(card.title).toBe("Projects: create: Fix the login")
    expect(card.lines).toEqual(["Project: Client portal", "Title: Fix the login"])
  })

  it("an `id` is the record the tool acts on, of its app", async () => {
    const card = await summary("projects:archive_thing", { id: task })
    expect(card.title).toBe("Projects: archive thing: Supplier portal rebuild")
    expect(card.lines).toEqual(["Task: Supplier portal rebuild"])
  })

  it("a list reads as names", async () => {
    const card = await summary("projects:bulk_touch", { taskIds: [task, OTHER_ID] })
    expect(card.lines).toEqual(["Task: Supplier portal rebuild and 1 more"])
  })

  it("a company shared by name is not named to every decider", async () => {
    const card = await summary("projects:link_client", { companyId: closedCompany })
    expect(JSON.stringify(card)).not.toContain("Quiet Holdings")
    const open = await summary("projects:link_client", { companyId: company })
    expect(open.lines).toEqual(["Company: Northwind Cooperative"])
  })

  it("a contact shared by name is not named either", async () => {
    const person = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.contacts", {
        id: person,
        org_id: w.orgId,
        name: "Quiet Person",
        email: "quiet@example.com",
        handle: `c-${person.slice(0, 8)}`,
        org_access: "none",
        created_by: w.userId,
        owner_user_id: w.userId,
      }),
    )
    const card = await summary("projects:link_person", { contactId: person })
    expect(card.lines).toEqual(["Contact: a restricted record"])
  })

  it("a document closed to the organization is not named, an open one is", async () => {
    const document = async (title: string, orgAccess: string) => {
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
    entityRegistry.set([w.orgId, "knowledge", "document"], {
      labelField: "title",
      handlePrefix: "doc",
      tableName: "documents",
    } as never)
    const open = await summary("projects:attach", {
      documentId: await document("Onboarding guide", "viewer"),
    })
    expect(open.lines).toEqual(["Document: Onboarding guide"])
    const closed = await summary("projects:attach", {
      documentId: await document("Board minutes", "none"),
    })
    expect(closed.lines).toEqual(["Document: a restricted record"])
    expect(JSON.stringify(closed)).not.toContain("Board minutes")
  })

  it("an id nobody can name is left out, and the caller's transaction goes on", async () => {
    const card = await summary("projects:touch_ghost", {
      ghostId: task,
      templateId: OTHER_ID,
      n: 1,
    })
    expect(card.title).toBe("Projects: touch ghost")
    expect(card.lines).toEqual(["N: 1"])
  })

  it("what may be one person's own is never looked up", async () => {
    const mail = { tool: "mail:archive", params: { conversationId: task } }
    entityRegistry.set([w.orgId, "projects", "conversation"], {
      labelField: "title",
      handlePrefix: "x",
      tableName: "tasks",
    } as never)
    // A kind of the same name in an app whose records are the organization's is read.
    expect((await summary(mail.tool, mail.params)).lines).toEqual([
      "Conversation: Supplier portal rebuild",
    ])
    entityRegistry.delete([w.orgId, "projects", "conversation"])
    const read = spyOn(referenceDisplay, "resolveEntityLabel")
    try {
      expect((await summary(mail.tool, mail.params)).lines).toEqual(["(no details to show)"])
      expect(read.mock.calls.map(([, at]) => `${at.app}:${at.entityType}`)).not.toContain(
        "mail:conversation",
      )
    } finally {
      read.mockRestore()
    }
  })

  it("an approvalCard template reads names too", async () => {
    const { registerApprovalSummarizer } = await import("~/modules/apps/approval-summarizers")
    registerApprovalSummarizer(
      w.orgId,
      "projects",
      "merge_into",
      templateApprovalSummarizer("Merge into {{params.taskId}}", "projects:merge_into"),
    )
    const card = await summary("projects:merge_into", { taskId: task })
    expect(card.title).toBe("Merge into Supplier portal rebuild")
  })

  it("a summarizer's own words keep an id only when nothing names it", async () => {
    const { registerApprovalSummarizer } = await import("~/modules/apps/approval-summarizers")
    registerApprovalSummarizer(w.orgId, "projects", "spoken", async () => ({
      kind: "projects.spoken",
      title: `Move ${task}`,
      lines: [`From ${OTHER_ID}`],
    }))
    const card = await summary("projects:spoken", { taskId: task, sourceId: OTHER_ID })
    expect(card.title).toBe("Move Supplier portal rebuild")
    expect(card.lines).toEqual([`From ${OTHER_ID}`])
  })
})
