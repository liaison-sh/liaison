// SPDX-License-Identifier: FSL-1.1-ALv2
// The shipped reference transforms (P4b T10), each run through the real import
// runner on fictional data: Freshdesk XML from files on disk (the CLI's path),
// Jira Software and Jira Service Management from a saved version over a fake
// Jira Cloud API (the agent's path). They are examples the agent reads, never
// importers in the product: these tests keep them from rotting.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { zipSync } from "fflate"
import { z } from "zod"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { BUILTIN_IMPORT_KINDS } from "~/modules/imports/builtin-kinds"
import { KERNEL_IMPORT_KINDS } from "~/modules/imports/kernel-kinds"
import {
  atlassianBaseUrl,
  REFERENCE_SOURCE_MAX_CHARS,
  REFERENCE_TRANSFORMS,
  readReference,
  referenceWithParams,
} from "~/modules/imports/reference/references"
import { runImport } from "~/modules/imports/runner"
import type { ApiConnectionClient } from "~/modules/imports/transform-run"
import { shutdownTransformPool } from "~/modules/imports/transforms/pool"
import { validateTransformSource } from "~/modules/imports/transforms/source"
import { saveTransform } from "~/modules/imports/transforms/store"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const FRESHDESK = join(import.meta.dir, "__fixtures__", "freshdesk")
const SLACK = join(import.meta.dir, "__fixtures__", "slack")
const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex")

let orgId = ""
let adminId = ""
const DEV_EMAIL = "dev@fabrikam.example"

function actor(): UserContext {
  return {
    actorType: "user",
    userId: adminId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `ref-${crypto.randomUUID().slice(0, 8)}`, name: "References" }))
    .orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `owner-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
      name: "Owner",
      password: "pw-ref-1!",
      role: "admin",
    })
  ).userId
  await ensureUser({
    orgId,
    email: DEV_EMAIL,
    name: "Dana Dev",
    password: "pw-ref-2!",
    role: "member",
  })
}, 120_000)

afterAll(async () => {
  await shutdownTransformPool()
  await releaseTestLock()
}, 60_000)

/** The kinds the bundled apps declare (`<app>.<kind>`, from their manifests' import section). */
function bundledAppKinds(): string[] {
  const root = join(import.meta.dir, "../../../../../../bundled-apps")
  return readdirSync(root).flatMap((app) => {
    const path = join(root, app, "app.manifest.json")
    if (!existsSync(path)) return []
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      import?: { kinds?: Record<string, unknown> }
    }
    return Object.keys(manifest.import?.kinds ?? {}).map((k) => `${app}.${k}`)
  })
}

describe("reference transforms: what ships", () => {
  it("each is a valid transform, fits a tool result, and emits built-in, kernel or bundled-app kinds only", () => {
    expect(Object.keys(REFERENCE_TRANSFORMS).sort()).toEqual([
      "freshdesk-xml",
      "invoice-csv",
      "jira-service-management",
      "jira-software",
      "slack-export",
    ])
    for (const name of Object.keys(REFERENCE_TRANSFORMS)) {
      const ref = readReference(name)
      expect(ref.code.length).toBeLessThanOrEqual(REFERENCE_SOURCE_MAX_CHARS)
      validateTransformSource(ref.code, ref.sourceType === "api" ? "pull" : "transform")
      for (const k of ref.kinds) {
        expect([
          ...Object.keys(BUILTIN_IMPORT_KINDS),
          ...Object.keys(KERNEL_IMPORT_KINDS),
          ...bundledAppKinds(),
        ]).toContain(k)
      }
      // Examples carry no infrastructure of ours: no real hosts, no keys.
      expect(ref.code).not.toMatch(/https?:\/\/(?!<site>)[a-z0-9.-]+\.(com|net|io)/i)
    }
  })
})

describe("reference settings", () => {
  it("a value carrying `$` patterns is written as is, never read as a replacement pattern", () => {
    const ref = {
      ...readReference("jira-software"),
      params: { PROJECT_KEYS: { about: "test", schema: z.array(z.string()) } },
    }
    const code = referenceWithParams(ref, { PROJECT_KEYS: ["$&", "$1", "$$", "$`"] })
    expect(code).toContain('const PROJECT_KEYS = ["$&","$1","$$","$`"]')
    expect(code.split("\n").length).toBe(ref.code.split("\n").length)
  })
})

async function ticketsOf(label: string) {
  return extractRows<{
    id: string
    external_ref: string
    status: string
    subject: string
    category_id: string | null
  }>(
    await sql`SELECT id, external_ref, status, subject, category_id FROM app_tickets.tickets
              WHERE org_id = ${orgId} AND external_ref LIKE ${`${label}:%`} ORDER BY external_ref`,
  )
}

async function messagesOf(ticketId: string) {
  return extractRows<{
    id: string
    kind: string
    text_body: string | null
    from_email: string | null
  }>(
    await sql`SELECT id, kind, text_body, from_email FROM app_tickets.messages
              WHERE ticket_id = ${ticketId} ORDER BY sent_at, created_at`,
  )
}

describe("freshdesk-xml", () => {
  const ref = () => readReference("freshdesk-xml")
  const run = (paths: string[]) =>
    runImport({
      orgId,
      actor: actor(),
      kinds: ref().kinds,
      source: {
        type: "transform",
        transform: { inline: ref().code, name: "freshdesk-xml" },
        input: { type: "paths", paths },
      },
      sourceLabel: "fdref",
      mode: "cli",
    })

  it("imports whole conversations with the directories' people, internal notes kept internal; a rerun skips", async () => {
    const first = await run([
      join(FRESHDESK, "Users0.xml"),
      join(FRESHDESK, "AllAgents0.xml"),
      join(FRESHDESK, "Tickets0.xml"),
    ])
    expect(first.status).toBe("done")
    expect(first.counts["tickets.ticket"]).toEqual({ created: 4, skipped: 0, failed: 0 })
    const tickets = await ticketsOf("fdref")
    expect(tickets.map((t) => t.external_ref)).toEqual([
      "fdref:freshdesk-555001",
      "fdref:freshdesk-555002",
      "fdref:freshdesk-555003",
      "fdref:freshdesk-555004",
    ])
    // Closed in Freshdesk; an agent spoke last on an "Open" ticket: awaiting
    // the customer; the customer spoke last: open.
    expect(tickets.map((t) => t.status)).toEqual(["closed", "awaiting_customer", "open", "closed"])
    const first1 = await messagesOf(tickets[0]!.id)
    expect(first1.map((m) => m.kind)).toEqual(["inbound", "outbound", "inbound", "note"])
    expect(first1.map((m) => m.from_email)).toEqual([
      "jane.customer@example.com",
      "agent.smith@fabrikam.example",
      "jane.customer@example.com",
      "agent.smith@fabrikam.example",
    ])
    // Entities decoded by the XML parser.
    expect(first1[2]!.text_body).toBe("That worked, thanks & cheers!")
    // No description and no note: the subject is the one message.
    const last = await messagesOf(tickets[3]!.id)
    expect(last.map((m) => [m.kind, m.text_body])).toEqual([
      ["inbound", "System generated: survey"],
    ])

    const again = await run([
      join(FRESHDESK, "Users0.xml"),
      join(FRESHDESK, "AllAgents0.xml"),
      join(FRESHDESK, "Tickets0.xml"),
    ])
    expect(again.counts["tickets.ticket"]).toEqual({ created: 0, skipped: 4, failed: 0 })
  }, 120_000)

  it("without the directories, messages import with no author email and nothing fails", async () => {
    const result = await runImport({
      orgId,
      actor: actor(),
      kinds: ref().kinds,
      source: {
        type: "transform",
        transform: { inline: ref().code, name: "freshdesk-xml" },
        input: { type: "paths", paths: [join(FRESHDESK, "Tickets0.xml")] },
      },
      sourceLabel: "fdnodir",
      mode: "cli",
    })
    expect(result.counts["tickets.ticket"]).toEqual({ created: 4, skipped: 0, failed: 0 })
    const tickets = extractRows<{ id: string }>(
      await sql`SELECT id FROM app_tickets.tickets WHERE org_id = ${orgId}
                AND external_ref = 'fdnodir:freshdesk-555001'`,
    )
    expect((await messagesOf(tickets[0]!.id)).every((m) => m.from_email === null)).toBe(true)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// A fake Jira Cloud (REST API v3) over a small fictional site
// ---------------------------------------------------------------------------

interface FakeIssue {
  key: string
  project: string
  type: "Epic" | "Story" | "Task" | "Sub-task" | "Service request"
  fields: Record<string, unknown>
  comments?: Array<Record<string, unknown>>
}

function adf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  }
}

function fakeJira(opts: {
  typeKey: "software" | "service_desk"
  projects: Array<{ key: string; name: string; description?: string }>
  statuses?: Record<string, Array<{ name: string; category: string }>>
  issues: FakeIssue[]
  files: Record<string, Uint8Array>
  fields?: Array<Record<string, unknown>>
}): ApiConnectionClient & { calls: string[] } {
  const calls: string[] = []
  const json = (data: unknown) => ({ status: 200, data, retryAfterMs: null })
  return {
    calls,
    async get(path) {
      calls.push(path)
      const url = new URL(`https://jira.invalid${path}`)
      const p = url.pathname
      if (p === "/rest/api/3/field") return json(opts.fields ?? [])
      if (p === "/rest/api/3/project/search") {
        if (url.searchParams.get("typeKey") !== opts.typeKey)
          return json({ values: [], isLast: true })
        return json({ values: opts.projects, isLast: true })
      }
      const st = /^\/rest\/api\/3\/project\/([^/]+)\/statuses$/.exec(p)
      if (st) {
        return json([
          {
            name: "Story",
            statuses: (opts.statuses?.[decodeURIComponent(st[1]!)] ?? []).map((s) => ({
              name: s.name,
              statusCategory: { key: s.category },
            })),
          },
        ])
      }
      if (p === "/rest/api/3/search/jql") {
        const jql = url.searchParams.get("jql") ?? ""
        const key = /project = "([^"]+)"/.exec(jql)?.[1]
        const pass = jql.includes("subTaskIssueTypes")
          ? (i: FakeIssue) => i.type === "Sub-task"
          : jql.includes("standardIssueTypes")
            ? (i: FakeIssue) => i.type !== "Epic" && i.type !== "Sub-task"
            : jql.includes("issuetype = Epic")
              ? (i: FakeIssue) => i.type === "Epic"
              : () => true
        const all = opts.issues.filter((i) => i.project === key && pass(i))
        // One issue per page: the transform must follow nextPageToken.
        const at = Number(url.searchParams.get("nextPageToken") ?? "0")
        const page = all.slice(at, at + 1)
        const more = at + 1 < all.length
        return json({
          issues: page.map((i) => ({
            key: i.key,
            fields: { ...i.fields, issuetype: { name: i.type } },
          })),
          ...(more ? { nextPageToken: String(at + 1) } : {}),
          isLast: !more,
        })
      }
      const cm = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(p)
      if (cm) {
        const issue = opts.issues.find((i) => i.key === decodeURIComponent(cm[1]!))
        if (!issue) return { status: 404, data: null, retryAfterMs: null }
        return json({ comments: issue.comments ?? [], total: (issue.comments ?? []).length })
      }
      return { status: 404, data: null, retryAfterMs: null }
    },
    async download(path) {
      calls.push(path)
      const id = /\/attachment\/content\/([^?]+)/.exec(path)?.[1] ?? ""
      const bytes = opts.files[decodeURIComponent(id)]
      if (!bytes) {
        return {
          status: 404,
          body: null,
          contentType: null,
          contentLength: null,
          filename: null,
          retryAfterMs: null,
        }
      }
      return {
        status: 200,
        body: new Blob([bytes]).stream(),
        contentType: "application/octet-stream",
        contentLength: bytes.byteLength,
        filename: null,
        retryAfterMs: null,
      }
    },
  }
}

async function saved(name: string, refName: string, params?: Record<string, unknown>) {
  const ref = readReference(refName)
  return withPrivilegedDb(orgId, "t", (tx) =>
    saveTransform(tx, {
      orgId,
      name,
      source: referenceWithParams(ref, params),
      kinds: ref.kinds,
      sourceType: "api",
      connectionIdentifier: "jira",
      createdBy: adminId,
    }),
  )
}

describe("jira-software", () => {
  const spec = new TextEncoder().encode("fictional release plan")
  const user = (email: string | null, name: string) => ({
    accountId: `acc-${name}`,
    displayName: name,
    ...(email ? { emailAddress: email } : {}),
  })
  const site = () =>
    fakeJira({
      typeKey: "software",
      projects: [
        { key: "FAB", name: "Fabrikam App", description: "The app" },
        { key: "OPS", name: "Fabrikam Ops" },
      ],
      statuses: {
        FAB: [
          { name: "To Do", category: "new" },
          { name: "Done", category: "done" },
        ],
        OPS: [{ name: "Open", category: "new" }],
      },
      issues: [
        {
          key: "FAB-1",
          project: "FAB",
          type: "Epic",
          fields: {
            summary: "Launch",
            status: { name: "To Do", statusCategory: { key: "new" } },
            created: "2024-01-02T09:00:00.000+0000",
          },
        },
        {
          key: "FAB-2",
          project: "FAB",
          type: "Story",
          fields: {
            summary: "Onboarding flow",
            description: adf("Users sign up in two steps."),
            status: { name: "To Do", statusCategory: { key: "new" } },
            priority: { name: "High" },
            reporter: user(DEV_EMAIL, "Dana Dev"),
            parent: { key: "FAB-1" },
            created: "2024-01-03T09:00:00.000+0000",
            attachment: [
              {
                id: "10001",
                filename: "plan.txt",
                mimeType: "text/plain",
                created: "2024-01-03T10:00:00.000+0000",
                author: user(DEV_EMAIL, "Dana Dev"),
              },
            ],
          },
          comments: [
            {
              author: user(DEV_EMAIL, "Dana Dev"),
              body: adf("First draft is up."),
              created: "2024-01-04T09:00:00.000+0000",
            },
            {
              author: user(null, "Hidden Person"),
              body: adf("Looks good to me."),
              created: "2024-01-05T09:00:00.000+0000",
            },
          ],
        },
        {
          key: "FAB-3",
          project: "FAB",
          type: "Sub-task",
          fields: {
            summary: "Copy for step two",
            status: { name: "Done", statusCategory: { key: "done" } },
            parent: { key: "FAB-2" },
            created: "2024-01-06T09:00:00.000+0000",
            resolutiondate: "2024-01-08T09:00:00.000+0000",
          },
        },
        {
          key: "FAB-4",
          project: "FAB",
          type: "Task",
          fields: {
            summary: "Pick a launch date",
            status: { name: "To Do", statusCategory: { key: "new" } },
            created: "2024-01-07T09:00:00.000+0000",
          },
        },
        {
          // An epic of another project, parent of a FAB story.
          key: "OPS-2",
          project: "OPS",
          type: "Epic",
          fields: {
            summary: "Infrastructure",
            status: { name: "Open", statusCategory: { key: "new" } },
            created: "2024-01-01T09:00:00.000+0000",
          },
        },
        {
          key: "FAB-5",
          project: "FAB",
          type: "Story",
          fields: {
            summary: "Monitoring for the app",
            status: { name: "To Do", statusCategory: { key: "new" } },
            parent: { key: "OPS-2" },
            created: "2024-01-08T09:00:00.000+0000",
          },
        },
        {
          // Its parent lives in a project this import does not read.
          key: "FAB-6",
          project: "FAB",
          type: "Story",
          fields: {
            summary: "Shared login",
            description: adf("Uses the company login."),
            status: { name: "To Do", statusCategory: { key: "new" } },
            parent: { key: "OUT-9" },
            created: "2024-01-09T09:00:00.000+0000",
          },
        },
        {
          key: "OPS-1",
          project: "OPS",
          type: "Task",
          fields: {
            summary: "Rotate the backup disk",
            status: { name: "Open", statusCategory: { key: "new" } },
            created: "2024-02-01T09:00:00.000+0000",
          },
        },
      ],
      files: { "10001": spec },
    })

  it("imports projects, epics before stories before subtasks, comments and attachments; a rerun skips", async () => {
    const t = await saved(`jira-sw-${crypto.randomUUID().slice(0, 6)}`, "jira-software")
    const api = site()
    const go = () =>
      runImport({
        orgId,
        actor: actor(),
        kinds: readReference("jira-software").kinds,
        source: {
          type: "transform",
          transform: { id: t.id, version: t.version },
          input: { type: "api", connection: "jira" },
        },
        sourceLabel: "jirasw",
        mode: "api",
        hooks: { apiConnection: () => api },
      })
    const result = await go()
    expect(result.status).toBe("done")
    expect(result.errors).toEqual([])
    expect(result.counts["projects.project"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    expect(result.counts["projects.task"]).toEqual({ created: 8, skipped: 0, failed: 0 })
    const tasks = extractRows<{
      external_ref: string
      id: string
      parent_task_id: string | null
      title: string
      description: string | null
      completed_at: string | null
    }>(
      await sql`SELECT external_ref, id, parent_task_id, title, description, completed_at FROM app_projects.tasks
                WHERE org_id = ${orgId} AND external_ref LIKE 'jirasw:%' ORDER BY external_ref`,
    )
    const byRef = Object.fromEntries(tasks.map((x) => [x.external_ref, x]))
    expect(byRef["jirasw:FAB-2"]?.parent_task_id).toBe(byRef["jirasw:FAB-1"]?.id)
    expect(byRef["jirasw:FAB-3"]?.parent_task_id).toBe(byRef["jirasw:FAB-2"]?.id)
    expect(byRef["jirasw:FAB-3"]?.completed_at).not.toBeNull()
    // A parent in another project (imported, or not read by the import) is
    // named in the description; the task imports without the link.
    expect(byRef["jirasw:FAB-5"]?.parent_task_id).toBeNull()
    expect(byRef["jirasw:FAB-5"]?.description).toContain(
      "Parent in Jira: OPS-2 (in another project)",
    )
    expect(byRef["jirasw:OPS-2"]).toBeDefined()
    expect(byRef["jirasw:FAB-6"]?.parent_task_id).toBeNull()
    expect(byRef["jirasw:FAB-6"]?.description).toContain("Parent in Jira: OUT-9 (not imported)")
    // A comment by a member is a message on the task; one whose author has no
    // email is folded into the description.
    expect(byRef["jirasw:FAB-2"]?.description).toContain("Users sign up in two steps.")
    expect(byRef["jirasw:FAB-2"]?.description).toContain("Looks good to me.")
    const files = extractRows<{ storage_key: string; filename: string }>(
      await sql`SELECT storage_key, filename FROM kernel.files WHERE org_id = ${orgId}
                AND app = 'projects' AND entity_type = 'task' AND entity_id = ${byRef["jirasw:FAB-2"]!.id}`,
    )
    expect(files.map((f) => f.filename)).toEqual(["plan.txt"])
    expect(sha(new Uint8Array(await getObjectBuffer(files[0]!.storage_key)))).toBe(sha(spec))
    expect(api.calls.some((c) => c.includes("nextPageToken="))).toBe(true)

    const again = await go()
    expect(again.counts["projects.task"]).toEqual({ created: 0, skipped: 8, failed: 0 })
  }, 180_000)
})

/** A fake Jira Service Management site: the servicedesk API plus the platform issue read. */
function fakeJsm(opts: {
  desks: Array<{ id: string; projectKey: string; projectName: string }>
  requestTypes: Array<{ id: string; name: string }>
  organizations: Array<{ id: string; name: string; members: Array<Record<string, unknown>> }>
  customers: Array<Record<string, unknown>>
  requests: Array<{
    request: Record<string, unknown>
    fields: Record<string, unknown>
    comments: Array<Record<string, unknown>>
  }>
  files: Record<string, Uint8Array>
}): ApiConnectionClient & { calls: string[] } {
  const calls: string[] = []
  const json = (data: unknown) => ({ status: 200, data, retryAfterMs: null })
  // Pages of one: the transform must follow start/isLastPage everywhere.
  const page = (all: unknown[], url: URL) => {
    const start = Number(url.searchParams.get("start") ?? "0")
    return json({ values: all.slice(start, start + 1), isLastPage: start + 1 >= all.length, start })
  }
  return {
    calls,
    async get(path) {
      calls.push(path)
      const url = new URL(`https://jira.invalid${path}`)
      const p = url.pathname
      if (p === "/rest/servicedeskapi/servicedesk") return page(opts.desks, url)
      if (/^\/rest\/servicedeskapi\/servicedesk\/[^/]+\/requesttype$/.test(p))
        return page(opts.requestTypes, url)
      if (/^\/rest\/servicedeskapi\/servicedesk\/[^/]+\/organization$/.test(p)) {
        return page(
          opts.organizations.map((o) => ({ id: o.id, name: o.name })),
          url,
        )
      }
      const members = /^\/rest\/servicedeskapi\/organization\/([^/]+)\/user$/.exec(p)
      if (members)
        return page(opts.organizations.find((o) => o.id === members[1])?.members ?? [], url)
      if (/^\/rest\/servicedeskapi\/servicedesk\/[^/]+\/customer$/.test(p))
        return page(opts.customers, url)
      // As on a live site where the agent's request list comes back empty: the
      // transform finds a desk's requests through the platform search instead.
      if (p === "/rest/servicedeskapi/request") return page([], url)
      if (p === "/rest/api/3/search/jql") {
        const jql = url.searchParams.get("jql") ?? ""
        const keys = opts.requests
          .map((r) => String(r.request.issueKey))
          .filter((k) => jql.includes(`"${k.split("-")[0]}"`))
        // Pages of one, by token.
        const at = Number(url.searchParams.get("nextPageToken") ?? "0")
        const last = at + 1 >= keys.length
        return json({
          issues: keys.slice(at, at + 1).map((key) => ({ key })),
          isLast: last,
          ...(last ? {} : { nextPageToken: String(at + 1) }),
        })
      }
      const one = /^\/rest\/servicedeskapi\/request\/([^/]+)$/.exec(p)
      if (one) {
        const r = opts.requests.find((x) => x.request.issueKey === decodeURIComponent(one[1]!))
        return r ? json(r.request) : { status: 404, data: null, retryAfterMs: null }
      }
      const issue = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(p)
      if (issue) {
        const r = opts.requests.find((x) => x.request.issueKey === decodeURIComponent(issue[1]!))
        return r
          ? json({ key: r.request.issueKey, fields: r.fields })
          : { status: 404, data: null, retryAfterMs: null }
      }
      const cm = /^\/rest\/servicedeskapi\/request\/([^/]+)\/comment$/.exec(p)
      if (cm) {
        const r = opts.requests.find((x) => x.request.issueKey === decodeURIComponent(cm[1]!))
        return r ? page(r.comments, url) : { status: 404, data: null, retryAfterMs: null }
      }
      return { status: 404, data: null, retryAfterMs: null }
    },
    async download(path) {
      calls.push(path)
      const id = /\/attachment\/content\/([^?]+)/.exec(path)?.[1] ?? ""
      const bytes = opts.files[decodeURIComponent(id)]
      if (!bytes) {
        return {
          status: 404,
          body: null,
          contentType: null,
          contentLength: null,
          filename: null,
          retryAfterMs: null,
        }
      }
      return {
        status: 200,
        body: new Blob([bytes]).stream(),
        contentType: "application/octet-stream",
        contentLength: bytes.byteLength,
        filename: null,
        retryAfterMs: null,
      }
    },
  }
}

describe("jira-service-management", () => {
  const shot = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])
  const log = new TextEncoder().encode("sso trace")
  const extra = new TextEncoder().encode("%PDF terms")
  const customer = {
    accountId: "cust-1",
    accountType: "customer",
    displayName: "Chloe Customer",
    emailAddress: "chloe@contoso.example",
  }
  const agent = {
    accountId: "agent-1",
    displayName: "Sam Agent",
    emailAddress: "sam@fabrikam.example",
  }
  const hidden = { accountId: "cust-2", accountType: "customer", displayName: "Private Person" }
  const at = (iso: string) => ({ iso8601: iso })
  const site = () =>
    fakeJsm({
      desks: [{ id: "1", projectKey: "SUP", projectName: "Support" }],
      requestTypes: [
        { id: "10", name: "Get help" },
        { id: "11", name: "Report a bug" },
      ],
      organizations: [{ id: "1", name: "Contoso Retail", members: [customer] }],
      customers: [customer, hidden],
      requests: [
        {
          request: {
            issueKey: "SUP-1",
            requestTypeId: "10",
            requestType: { id: "10", name: "Get help" },
            createdDate: at("2024-03-01T09:00:00+0000"),
            reporter: customer,
            requestFieldValues: [{ fieldId: "summary", value: "Cannot log in" }],
            currentStatus: { status: "Waiting for support", statusCategory: "INDETERMINATE" },
          },
          fields: {
            description: adf("The login page spins forever."),
            priority: { name: "High" },
            assignee: agent,
            attachment: [
              { id: "20001", filename: "screen.png", mimeType: "image/png", author: customer },
              { id: "20002", filename: "sso-log.txt", mimeType: "text/plain", author: agent },
              { id: "20003", filename: "terms.pdf", mimeType: "application/pdf", author: agent },
            ],
          },
          comments: [
            {
              body: "Could you clear your cookies?",
              public: true,
              author: agent,
              created: at("2024-03-01T10:00:00+0000"),
            },
            {
              body: "Probably the SSO change. !sso-log.txt!",
              public: false,
              author: agent,
              created: at("2024-03-01T10:05:00+0000"),
            },
            {
              body: "Still spinning. !screen.png|thumbnail!",
              public: true,
              author: customer,
              created: at("2024-03-01T11:00:00+0000"),
            },
          ],
        },
        {
          request: {
            issueKey: "SUP-2",
            requestTypeId: "11",
            requestType: { id: "11", name: "Report a bug" },
            createdDate: at("2024-03-02T09:00:00+0000"),
            reporter: hidden,
            requestFieldValues: [{ fieldId: "summary", value: "Bug in export" }],
            currentStatus: { status: "Done", statusCategory: "DONE" },
          },
          fields: {},
          comments: [],
        },
      ],
      files: { "20001": shot, "20002": log, "20003": extra },
    })

  it("imports from the servicedesk API: request types, customers with their organization, public replies and internal notes, attachments where the comments place them", async () => {
    const t = await saved(`jira-sm-${crypto.randomUUID().slice(0, 6)}`, "jira-service-management")
    const api = site()
    const result = await runImport({
      orgId,
      actor: actor(),
      kinds: readReference("jira-service-management").kinds,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "api", connection: "jira" },
      },
      sourceLabel: "jirasm",
      mode: "api",
      placeholders: true,
      hooks: { apiConnection: () => api },
    })
    expect(result.status).toBe("done")
    expect(result.errors).toEqual([])
    expect(result.counts["tickets.category"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    expect(result.counts["tickets.ticket"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    expect(result.counts["contacts.contact"]?.created).toBe(2)
    // Every list was read through the servicedesk API, page by page.
    for (const prefix of [
      "/rest/servicedeskapi/servicedesk/1/customer",
      "/rest/servicedeskapi/servicedesk/1/requesttype",
      "/rest/servicedeskapi/organization/1/user",
      "/rest/servicedeskapi/request/SUP-1/comment",
      "/rest/api/3/search/jql",
      "/rest/servicedeskapi/request/SUP-2",
    ]) {
      expect(api.calls.some((c) => c.startsWith(prefix))).toBe(true)
    }
    expect(api.calls.some((c) => c.includes("start=1"))).toBe(true)
    const tickets = await ticketsOf("jirasm")
    expect(tickets.map((x) => x.status)).toEqual(["open", "closed"])
    expect(tickets.every((x) => x.category_id !== null)).toBe(true)
    const msgs = await messagesOf(tickets[0]!.id)
    // Description, public reply, internal note, customer reply, and an internal
    // note holding the files no message placed.
    expect(msgs.map((m) => m.kind)).toEqual(["inbound", "outbound", "note", "inbound", "note"])
    const contact = extractRows<{ company: string | null }>(
      await sql`SELECT company FROM kernel.contacts WHERE org_id = ${orgId} AND email = 'chloe@contoso.example'`,
    )
    expect(contact[0]?.company).toBe("Contoso Retail")
    const files = extractRows<{ storage_key: string; entity_id: string; filename: string }>(
      await sql`SELECT storage_key, entity_id, filename FROM kernel.files WHERE org_id = ${orgId}
                AND filename IN ('screen.png', 'sso-log.txt', 'terms.pdf')`,
    )
    const where = Object.fromEntries(files.map((f) => [f.filename, f.entity_id]))
    expect(where["screen.png"]).toBe(msgs[3]!.id)
    expect(where["sso-log.txt"]).toBe(msgs[2]!.id)
    // A file no message names never lands on a public message.
    expect(where["terms.pdf"]).toBe(msgs[4]!.id)
    const shotRow = files.find((f) => f.filename === "screen.png")!
    expect(sha(new Uint8Array(await getObjectBuffer(shotRow.storage_key)))).toBe(sha(shot))
  }, 180_000)

  it("DESK_KEYS limits the import to the named service desks", async () => {
    const t = await saved(`jira-sm-${crypto.randomUUID().slice(0, 6)}`, "jira-service-management", {
      DESK_KEYS: ["OTHER"],
    })
    const api = site()
    const result = await runImport({
      orgId,
      actor: actor(),
      kinds: readReference("jira-service-management").kinds,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "api", connection: "jira" },
      },
      sourceLabel: "jirasm-none",
      mode: "api",
      placeholders: true,
      hooks: { apiConnection: () => api },
    })
    expect(result.status).toBe("done")
    expect(result.counts["tickets.ticket"]?.created ?? 0).toBe(0)
    expect(api.calls.some((c) => c.startsWith("/rest/servicedeskapi/servicedesk/1/"))).toBe(false)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// A standard Slack export (a zip: users.json, channels.json, groups.json, one
// folder of daily JSON files per channel), fictional
// ---------------------------------------------------------------------------

/** The fixture folder zipped the way Slack ships an export. */
function slackZip(): { dir: string; path: string } {
  const entries: Record<string, Uint8Array> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else entries[relative(SLACK, p)] = new Uint8Array(readFileSync(p))
    }
  }
  walk(SLACK)
  const dir = mkdtempSync(join(tmpdir(), "slack-ref-"))
  const path = join(dir, "Fabrikam Slack export.zip")
  writeFileSync(path, zipSync(entries))
  return { dir, path }
}

describe("slack-export", () => {
  const ref = () => readReference("slack-export")
  const run = (zip: string) =>
    runImport({
      orgId,
      actor: actor(),
      kinds: ref().kinds,
      source: {
        type: "transform",
        transform: { inline: ref().code, name: "slack-export" },
        input: { type: "paths", paths: [zip] },
        files: ref().files,
      },
      sourceLabel: "slkref",
      mode: "cli",
      placeholders: true,
    })

  it("imports public and private channels with their history: replies, broadcasts, bots, joins, reactions, edits; direct messages left out; a rerun skips", async () => {
    const zip = slackZip()
    try {
      const first = await run(zip.path)
      expect(first.status).toBe("done")
      expect(first.errors).toEqual([])
      expect(first.counts["chat.thread"]).toEqual({ created: 3, skipped: 0, failed: 0 })
      expect(first.counts["chat.message"]).toEqual({ created: 8, skipped: 0, failed: 0 })

      const threads = extractRows<{
        id: string
        handle: string
        discoverable: boolean
        topic: string | null
        description: string | null
      }>(
        await sql`SELECT id, handle, discoverable, topic, description FROM kernel.threads
                  WHERE org_id = ${orgId} AND handle LIKE 'slkref-%' ORDER BY handle`,
      )
      expect(threads.map((t) => [t.handle, t.discoverable])).toEqual([
        ["slkref-design", false],
        ["slkref-general", true],
        ["slkref-old-launch", true],
      ])
      const general = threads.find((t) => t.handle === "slkref-general")!
      expect(general.topic).toBe("Company-wide news")
      expect(general.description).toBe("Announcements and chatter")

      const msgs = extractRows<{
        id: string
        content: string
        author_type: string
        email: string | null
        reply_root_id: string | null
        also_in_channel: boolean
        edited_at: string | null
        created_at: string
      }>(
        await sql`SELECT m.id, m.content, m.author_type, u.email, m.reply_root_id, m.also_in_channel,
                         m.edited_at, m.created_at
                  FROM kernel.messages m LEFT JOIN kernel.users u ON u.id = m.author_id
                  WHERE m.thread_id = ${general.id} ORDER BY m.created_at`,
      )
      expect(msgs).toHaveLength(6)
      const [hello, join_, reply, broadcast, bot, plan] = msgs
      // Original time and author; Slack's markup made readable.
      expect(new Date(hello!.created_at).toISOString()).toBe("2024-03-01T10:00:00.000Z")
      expect(hello!.email).toBe(DEV_EMAIL)
      expect(hello!.content).toBe(
        "Hello @Lee Leaver, welcome! See #old-launch and [the docs](https://example.com/docs).",
      )
      expect(join_!.author_type).toBe("system")
      expect(reply!.content).toBe("Thanks & hi")
      expect(reply!.reply_root_id).toBe(hello!.id)
      expect(broadcast!.reply_root_id).toBe(hello!.id)
      expect(broadcast!.also_in_channel).toBe(true)
      // A leaver and a bot become placeholders, never a real member.
      expect(reply!.email).not.toBe(DEV_EMAIL)
      expect(bot!.email).not.toBe(DEV_EMAIL)
      expect(bot!.content).toBe("Deployed v1.2")
      // Files stay on Slack's servers: the message says which ones.
      expect(plan!.content).toContain("plan.pdf")
      expect(plan!.edited_at).not.toBeNull()

      const reactions = extractRows<{ emoji: string }>(
        await sql`SELECT emoji FROM kernel.message_reactions WHERE message_id = ${hello!.id}`,
      )
      // Reactions by members of the org; a reactor who is no member is counted, not invented.
      expect(reactions.map((r) => r.emoji)).toEqual(["👍"])

      const again = await run(zip.path)
      expect(again.counts["chat.thread"]).toEqual({ created: 0, skipped: 3, failed: 0 })
      // The private channel's history is skipped only for someone who can see it:
      // the importer is no member of #design, so its message is refused, never
      // written twice.
      expect(again.counts["chat.message"]).toEqual({ created: 0, skipped: 7, failed: 1 })
      expect(again.errors.map((e) => e.error)).toEqual([
        'threadRef "design" is not a channel this run created or one you can see',
      ])
    } finally {
      rmSync(zip.dir, { recursive: true, force: true })
    }
  }, 180_000)
})

describe("the Jira site the person gives becomes only an atlassian.net base URL", () => {
  it.each([
    ["acme", "https://acme.atlassian.net"],
    ["ACME", "https://acme.atlassian.net"],
    ["acme.atlassian.net", "https://acme.atlassian.net"],
    ["https://acme.atlassian.net", "https://acme.atlassian.net"],
    ["http://acme.atlassian.net", "https://acme.atlassian.net"],
    ["acme.atlassian.net:443", "https://acme.atlassian.net"],
    ["https://acme.atlassian.net:8443/jira", "https://acme.atlassian.net"],
    [
      "https://acme.atlassian.net/jira/software/projects/NWA/boards/1",
      "https://acme.atlassian.net",
    ],
  ])("%s -> %s", (site, base) => {
    expect(atlassianBaseUrl(site)).toBe(base)
  })

  it.each([
    "evil.com/acme.atlassian.net",
    "acme.atlassian.net.evil.com",
    "https://acme.atlassian.net@evil.com",
    "evil.com#acme.atlassian.net",
    "https://evil.com/#acme.atlassian.net",
    "user@evil.com",
    "atlassian.net",
    "",
    "-acme",
  ])("%s is refused", (site) => {
    expect(atlassianBaseUrl(site)).toBeNull()
  })
})
