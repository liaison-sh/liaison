// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import {
  connectionConfigRegistry,
  manifestRegistry,
  viewRegistry,
} from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"

const ORG = "550e8400-e29b-41d4-a716-446655440060"
const USER1 = "550e8400-e29b-41d4-a716-446655440061"
const ROLE_ID = "550e8400-e29b-41d4-a716-44665544006a"
const PROJECT_THREAD_ID = "550e8400-e29b-41d4-a716-44665544006b"
const PROJECT_TASK_ID = "550e8400-e29b-41d4-a716-44665544006c"
let token: string
let ticketReaderToken: string
let projectReaderToken: string
let previousProjectsManifest: unknown

describe("references routes", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'RefOrg', 'reforg') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER1}, ${ORG}, 'ref@t.com', 'RefUser') ON CONFLICT DO NOTHING`

    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE_ID}, ${ORG}, 'ref-member', 'Ref test member') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}, 'kernel') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER1}, ${ROLE_ID}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
      VALUES (${PROJECT_THREAD_ID}, ${ORG}, 'thread-project-backlink', 'Project backlink thread', ${USER1})
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${PROJECT_THREAD_ID}, ${USER1}, ${ORG}, 'member')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_references (thread_id, org_id, app, entity_type, entity_id, added_by)
      VALUES (${PROJECT_THREAD_ID}, ${ORG}, 'projects', 'task', ${PROJECT_TASK_ID}, ${USER1})
      ON CONFLICT DO NOTHING`

    previousProjectsManifest = manifestRegistry.get([ORG, "projects"])
    manifestRegistry.set([ORG, "projects"], {
      name: "projects",
      entities: {
        task: { readScope: "projects:projects:read", handlePrefix: "task" },
      },
    } as any)

    // open-target fixtures: a shopify app with an external-only `order` detail
    // (no component) and a component-backed `customer` detail, plus an active
    // connection so the shop-domain template var resolves.
    viewRegistry.set([ORG, "shopify"], {
      detail: {
        order: {
          externalLink: {
            urlTemplate: "https://{{shop}}.myshopify.com/admin/orders/{{id}}",
            label: "Open in Shopify",
          },
        },
        customer: {
          component: "CustomerPanel",
          externalLink: {
            urlTemplate: "https://{{shop}}.myshopify.com/admin/customers/{{id}}",
            label: "Open in Shopify",
          },
        },
      },
    } as any)
    connectionConfigRegistry.set([ORG, "shopify", "shopify"], {
      type: "oauth2",
      allowedDomains: [],
      identifierVar: "shop",
      templateVars: { shop: { pattern: ".*", appendSuffix: ".myshopify.com" } },
    } as any)
    await sql`INSERT INTO kernel.connected_accounts
      (org_id, app_name, connection_name, owner_type, provider_type, identifier, status, created_by)
      VALUES (${ORG}, 'shopify', 'shopify', 'org', 'oauth2', 'acme.myshopify.com', 'active', ${USER1})
      ON CONFLICT DO NOTHING`

    token = await signAccessToken(
      {
        userId: USER1,
        orgId: ORG,
        name: "RefUser",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
      },
      env.JWT_SECRET,
    )
    ticketReaderToken = await signAccessToken(
      {
        userId: USER1,
        orgId: ORG,
        name: "RefUser",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["tickets:tickets:read"],
      },
      env.JWT_SECRET,
    )
    projectReaderToken = await signAccessToken(
      {
        userId: USER1,
        orgId: ORG,
        name: "RefUser",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["projects:projects:read"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    if (previousProjectsManifest) {
      manifestRegistry.set([ORG, "projects"], previousProjectsManifest as any)
    } else {
      manifestRegistry.delete([ORG, "projects"])
    }
    viewRegistry.delete([ORG, "shopify"])
    connectionConfigRegistry.delete([ORG, "shopify", "shopify"])
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_references WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("GET /api/references with valid auth returns 200", async () => {
    const res = await app.request("/api/references?app=tickets&entityType=ticket&entityId=t1", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(Array.isArray(body.data)).toBe(true)
  })

  it("GET /api/references allows app entity readers without kernel thread-read scope", async () => {
    const res = await app.request("/api/references?app=tickets&entityType=ticket&entityId=t1", {
      headers: { Authorization: `Bearer ${ticketReaderToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(Array.isArray(body.data)).toBe(true)
  })

  it("GET /api/references returns project task backlinks for project readers without kernel thread-read", async () => {
    const res = await app.request(
      `/api/references?app=projects&entityType=task&entityId=${PROJECT_TASK_ID}`,
      {
        headers: { Authorization: `Bearer ${projectReaderToken}` },
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toContainEqual(
      expect.objectContaining({
        threadId: PROJECT_THREAD_ID,
        handle: "thread-project-backlink",
        title: "Project backlink thread",
      }),
    )
  })

  it("GET /api/references hides project task backlinks without project read scope", async () => {
    const res = await app.request(
      `/api/references?app=projects&entityType=task&entityId=${PROJECT_TASK_ID}`,
      {
        headers: { Authorization: `Bearer ${ticketReaderToken}` },
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual([])
  })

  it("GET /api/references without auth returns 401", async () => {
    const res = await app.request("/api/references?app=tickets&entityType=ticket&entityId=t1")
    expect(res.status).toBe(401)
  })

  it("GET /api/references/open-target resolves an external-only entity to its deep link", async () => {
    const res = await app.request(
      "/api/references/open-target?app=shopify&entityType=order&entityId=1234",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual({
      kind: "external",
      url: "https://acme.myshopify.com/admin/orders/1234",
      label: "Open in Shopify",
    })
  })

  it("GET /api/references/open-target returns internal for an entity with an in-app component", async () => {
    // `customer` declares a component panel — it opens in-app, so no external URL.
    const res = await app.request(
      "/api/references/open-target?app=shopify&entityType=customer&entityId=c1",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual({ kind: "internal" })
  })

  it("GET /api/references/open-target returns internal for an entity with no external link", async () => {
    const res = await app.request(
      "/api/references/open-target?app=tickets&entityType=ticket&entityId=t1",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual({ kind: "internal" })
  })

  it("GET /api/references/open-target without auth returns 401", async () => {
    const res = await app.request(
      "/api/references/open-target?app=shopify&entityType=order&entityId=1234",
    )
    expect(res.status).toBe(401)
  })
})
