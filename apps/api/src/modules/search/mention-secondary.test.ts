// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Four picker rows all called "Email-bounce dashboard for support" and nothing
// to choose between them: the row has to carry a fact of its own.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { threadAnchorTitle } from "@liaison/shared"
import { sql } from "~/db"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { serverT } from "~/modules/i18n/server-i18n"
import { attachMentionSecondaryLabels } from "~/modules/search/mention-secondary"
import type { MentionHit } from "~/modules/search/service"
import { resolveThreadAnchorForReaders } from "~/modules/threads/thread-anchor"

const ORG = "550e8400-e29b-41d4-a716-4466554400b0"
const USER = "550e8400-e29b-41d4-a716-4466554400b1"
const SAME_TITLE = "Email-bounce dashboard for support"

let taskInSupport: string
let taskInGrowth: string

async function seedProject(name: string, key: string): Promise<{ id: string; statusId: string }> {
  const [project] = await sql`
    INSERT INTO app_projects.projects (org_id, name, owner_id, key)
    VALUES (${ORG}, ${name}, ${USER}, ${key}) RETURNING id`
  const [status] = await sql`
    INSERT INTO app_projects.project_statuses (org_id, project_id, label, "order")
    VALUES (${ORG}, ${project.id}, 'Todo', 0) RETURNING id`
  return { id: project.id, statusId: status.id }
}

async function seedTask(project: { id: string; statusId: string }, n: number): Promise<string> {
  const [thread] = await sql`
    INSERT INTO kernel.threads (org_id, handle, title, created_by)
    VALUES (${ORG}, ${`mention-secondary-${n}`}, ${SAME_TITLE}, ${USER}) RETURNING id`
  const [task] = await sql`
    INSERT INTO app_projects.tasks (org_id, project_id, status_id, title, thread_id, created_by, number)
    VALUES (${ORG}, ${project.id}, ${project.statusId}, ${SAME_TITLE}, ${thread.id}, ${USER}, ${n})
    RETURNING id`
  return task.id
}

describe("mention picker secondary labels", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'MentionOrg', 'mentionorg') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'mention@t.com', 'M') ON CONFLICT DO NOTHING`
    // The join is the projects app's own declaration (labelSecondaryFrom),
    // read from the org's live registry like any other app's.
    await ensureAppsForOrg(ORG)
    const support = await seedProject("Support", "SUP")
    const growth = await seedProject("Growth", "GRO")
    taskInSupport = await seedTask(support, 1)
    taskInGrowth = await seedTask(growth, 2)
  })

  afterAll(async () => {
    await sql`DELETE FROM app_projects.tasks WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_projects.project_statuses WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_projects.projects WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("tells two same titled tasks apart by their project", async () => {
    const hits: MentionHit[] = [
      { type: "task", id: taskInSupport, label: SAME_TITLE, app: "projects", entityType: "task" },
      { type: "task", id: taskInGrowth, label: SAME_TITLE, app: "projects", entityType: "task" },
    ]
    await attachMentionSecondaryLabels(ORG, hits)
    expect(hits[0].secondaryLabel).toBe("Support")
    expect(hits[1].secondaryLabel).toBe("Growth")
    expect(hits[0].secondaryLabel).not.toBe(hits[1].secondaryLabel)
  })

  it("leaves a label the search index already supplied alone", async () => {
    const hits: MentionHit[] = [
      {
        type: "task",
        id: taskInSupport,
        label: SAME_TITLE,
        secondaryLabel: "SUP-1",
        app: "projects",
        entityType: "task",
      },
    ]
    await attachMentionSecondaryLabels(ORG, hits)
    expect(hits[0].secondaryLabel).toBe("SUP-1")
  })
})

// The words a notification says about the entity a thread belongs to (its
// title and this secondary label) are read under EACH reader's own visibility
// (RLS as that person), never once for the whole audience: a member who
// cannot see the task, the private contact or the approval gets no name, no
// project, no title. Real rows, real policies (threads/thread-anchor.ts).
const A_ORG = crypto.randomUUID()
const OWNER = crypto.randomUUID()
const READER = crypto.randomUUID()
const OUTSIDER = crypto.randomUUID()
const ROLE_READ = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)
const t = (key: string) => serverT("en", key)

let privateContact = ""
let task = ""
let approval = ""

describe("thread anchor words, per reader", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${A_ORG}, 'Anchor org', ${`anchor-${tag}`})`
    for (const [id, name] of [
      [OWNER, "Owner"],
      [READER, "Reader"],
      [OUTSIDER, "Outsider"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name)
        VALUES (${id}, ${A_ORG}, ${`anchor-${name}-${tag}@t.com`}, ${name})`
    }
    // OWNER and READER may read projects; OUTSIDER is a member with no project access.
    await sql`INSERT INTO kernel.roles (id, org_id, name, description)
      VALUES (${ROLE_READ}, ${A_ORG}, ${`anchor-read-${tag}`}, 'reads projects')`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_READ}, 'projects:projects:read')`
    for (const id of [OWNER, READER]) {
      await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${id}, ${ROLE_READ}, ${A_ORG})`
    }
    await ensureAppsForOrg(A_ORG)

    const [c] = await sql<{ id: string }[]>`
      INSERT INTO kernel.contacts (org_id, handle, name, owner_user_id, org_access)
      VALUES (${A_ORG}, ${`anchor-contact-${tag}`}, 'Secret Supplier', ${OWNER}, 'none') RETURNING id`
    privateContact = c.id

    const [project] = await sql<{ id: string }[]>`
      INSERT INTO app_projects.projects (org_id, name, owner_id, key)
      VALUES (${A_ORG}, 'Acquisition', ${OWNER}, 'ACQ') RETURNING id`
    const [status] = await sql<{ id: string }[]>`
      INSERT INTO app_projects.project_statuses (org_id, project_id, label, "order")
      VALUES (${A_ORG}, ${project.id}, 'Todo', 0) RETURNING id`
    const [taskThread] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by)
      VALUES (${A_ORG}, ${`anchor-task-${tag}`}, ${OWNER}) RETURNING id`
    const [tk] = await sql<{ id: string }[]>`
      INSERT INTO app_projects.tasks (org_id, project_id, status_id, title, thread_id, created_by, number)
      VALUES (${A_ORG}, ${project.id}, ${status.id}, 'Draft the term sheet', ${taskThread.id}, ${OWNER}, 1)
      RETURNING id`
    task = tk.id

    const [approvalThread] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by, type, hidden_from_list)
      VALUES (${A_ORG}, ${`anchor-approval-${tag}`}, ${OWNER}, 'approval', true) RETURNING id`
    const [ap] = await sql<{ id: string }[]>`
      INSERT INTO kernel.approval_requests
        (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params, current_payload,
         expires_at, requested_by, summary)
      VALUES (${A_ORG}, ${`request-${tag}`}, ${approvalThread.id}, ${approvalThread.id}, 'tickets:reply',
        '{}'::jsonb, '{}'::jsonb, now() + interval '1 day', ${OWNER},
        ${JSON.stringify({ title: "Refund order 1042" })}::jsonb)
      RETURNING id`
    approval = ap.id
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${A_ORG}`
    await sql`DELETE FROM app_projects.tasks WHERE org_id = ${A_ORG}`
    await sql`DELETE FROM app_projects.project_statuses WHERE org_id = ${A_ORG}`
    await sql`DELETE FROM app_projects.projects WHERE org_id = ${A_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${A_ORG}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${A_ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${A_ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE_READ}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${A_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${A_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${A_ORG}`
  })

  it("a task: its reader gets the title and project, a member without project access nothing", async () => {
    const ref = { app: "projects", entityType: "task", entityId: task }
    const words = await resolveThreadAnchorForReaders(A_ORG, ref, [READER, OUTSIDER])
    const seen = words.get(READER)
    expect(seen?.label).toBe("Draft the term sheet")
    expect(seen?.secondaryLabel).toBe("Acquisition")
    expect(threadAnchorTitle(seen!, t)).toBe("Task: Draft the term sheet · Acquisition")
    expect(words.get(OUTSIDER)).toBeNull()
    expect(words.size).toBe(2)
  })

  it("a private contact: only its owner gets its name", async () => {
    const ref = { app: "kernel", entityType: "contact", entityId: privateContact }
    const words = await resolveThreadAnchorForReaders(A_ORG, ref, [OWNER, READER])
    expect(words.get(OWNER)?.label).toBe("Secret Supplier")
    expect(words.get(READER)).toBeNull()
  })

  it("an approval is titled with its own title for a reader who may see it", async () => {
    const ref = { app: "kernel", entityType: "approval_request", entityId: approval }
    const words = await resolveThreadAnchorForReaders(A_ORG, ref, [OWNER, OUTSIDER])
    const seen = words.get(OWNER)
    expect(seen?.label).toBe("Refund order 1042")
    expect(threadAnchorTitle(seen!, t)).toBe("Approval: Refund order 1042")
    expect(words.get(OUTSIDER)).toBeNull()
  })

  it("an entity that is gone names nothing to anyone", async () => {
    const ref = { app: "projects", entityType: "task", entityId: crypto.randomUUID() }
    const words = await resolveThreadAnchorForReaders(A_ORG, ref, [OWNER])
    expect(words.get(OWNER)).toBeNull()
  })
})
