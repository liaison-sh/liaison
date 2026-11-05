// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two-org isolation sweep, enumerated from the booted app.
//
// Org A and org B each have an admin (wildcard scopes). Org A's ids are
// HARVESTED, not hand-listed: every parameterless GET route is called as A and
// every UUID in its answers that B's own answers do not carry is an org-A id.
// Then, for every GET route with a path parameter and every org-A id:
//   positive control: A's request answers 2xx (the id is a real org-A object
//     for that route);
//   assertion: B's identical request does not answer 2xx carrying that id or
//     any other org-A id. A route that only echoes its path parameter passes
//     when B's answer equals, id masked, its answer for a never-existing id.
// For every write route (POST/PUT/PATCH/DELETE) under a resource whose GET
// answered A with an id, B's write against that id must not answer 2xx, and A's
// GET of the resource must be byte-identical afterwards.
//
// What it cannot see: ids passed in query strings or bodies, routes whose GET
// sibling does not exist, and writes refused for body shape before any lookup
// (those answer 4xx for B as well and are not counted as proof either way).
// The documents routes take their ids in the query and the body, so they get
// their own probe below (the full cross-org print proof, with a printable
// record type in both orgs, is modules/documents/print.test.ts).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedTwoOrgsWithIsolatedData, type TwoOrgsFixture } from "~/tests/security/seeds"

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Routes this sweep must not call at all (side effects outside the two orgs, or streams). */
const SKIP = [
  /^\/api\/_test\//,
  /^\/api\/agent\/chat/,
  /^\/api\/auth\//,
  /^\/mcp/,
  /^\/\.well-known/,
  /^\/webhooks\//,
  /^\/api\/file-relay/,
  /^\/api\/demo/,
  /^\/api\/export/,
  /^\/healthz/,
  /^\/diag/,
  /^\/api\/admin\/billing/,
]

interface Hit {
  route: string
  status: number
  body: string
}

let fx: TwoOrgsFixture
const orgAIds = new Set<string>()
/** GET route pattern -> org-A ids for which A's own GET answered 2xx. */
const resourceIds = new Map<string, string[]>()
const readLeaks: string[] = []
const writeLeaks: string[] = []
let readPairsChecked = 0
const readRoutesChecked = new Set<string>()
let writePairsChecked = 0
/** Org A's document template, printable as SWEEP_RECORD_TYPE. */
let templateA = ""
const SWEEP_RECORD_TYPE = { app: "sweepfixture", entity: "record" }

function routes(method: string): string[] {
  const out = new Set<string>()
  for (const r of app.routes) {
    if (r.method !== method) continue
    if (SKIP.some((re) => re.test(r.path))) continue
    out.add(r.path)
  }
  return [...out].sort()
}

async function call(method: string, path: string, token: string): Promise<Hit> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` } }
  if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
    init.body = "{}"
    ;(init.headers as Record<string, string>)["content-type"] = "application/json"
  }
  const res = await app.request(path, init)
  const body = await res.text().catch(() => "")
  return { route: path, status: res.status, body }
}

function paramNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1] as string)
}

/** A body with every occurrence of `id` replaced, to compare answers for two ids. */
function masked(body: string, id: string): string {
  return body.toLowerCase().split(id.toLowerCase()).join("<id>")
}

function fill(path: string, id: string): string {
  // One id per path: routes with several parameters are filled only on the
  // first, the rest get a value that matches nothing.
  let first = true
  return path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, () => {
    if (first) {
      first = false
      return id
    }
    return "00000000-0000-4000-8000-00000000dead"
  })
}

beforeAll(async () => {
  await acquireTestLock()
  fx = await seedTwoOrgsWithIsolatedData()
  await minimal.contact(fx.orgA.id, `contact-a-${crypto.randomUUID()}@a.example`)
  await minimal.contact(fx.orgB.id, `contact-b-${crypto.randomUUID()}@b.example`)

  // Give both orgs one object of each common kind, through their own API.
  const seed = (n: string): Array<[string, unknown]> => [
    ["/api/saved-views", { app: "tickets", viewId: `v-${n}`, name: `view ${n}`, payload: {} }],
    ["/api/admin/roles", { name: `role-${n}` }],
    ["/api/contacts/groups", { name: `group ${n}` }],
    ["/api/trusted-senders", { kind: "address", value: `trusted-${n}@example.com` }],
    [
      "/api/document-templates",
      {
        kind: "rich_text",
        name: `template ${n}`,
        body: { blocks: [{ type: "paragraph", text: "{{name}}" }] },
        recordType: `${SWEEP_RECORD_TYPE.app}:${SWEEP_RECORD_TYPE.entity}`,
      },
    ],
    ["/api/projects", { name: `project ${n}` }],
    ["/api/agent/skills", { name: `skill-${n}`, description: "x", body: "x", visibility: "org" }],
    [
      "/api/agent/skills",
      { name: `pskill-${n}`, description: "x", body: "x", visibility: "personal" },
    ],
    [
      "/api/agent/routines",
      {
        name: `routine-${n}`,
        description: "x",
        prompt: "x",
        kind: "recurring",
        cron: "0 0 * * *",
        timezone: "UTC",
      },
    ],
    ["/api/agent/memories", { type: "user", name: `memory-${n}`, description: "x", content: "x" }],
    ["/api/threads", { participantIds: [], title: `thread ${n}` }],
    ["/api/scope-requests", { scopes: ["kernel:audit:read"] }],
    ["/api/knowledge/documents", { documentScope: "org", title: `doc ${n}` }],
    ["/api/knowledge/documents", { documentScope: "personal", title: `pdoc ${n}` }],
    ["/api/knowledge/collections", { name: `collection ${n}` }],
    ["/api/knowledge/tags", { name: `tag-${n}` }],
    ["/api/attention/subscriptions", { source: "*", kinds: ["x"], enabled: true }],
    ["/api/agents", { handle: `agent-${n}`, displayName: `Agent ${n}` }],
    [
      "/api/apps/mcp-manager/connections",
      {
        slug: `conn-${n}`,
        displayName: `Conn ${n}`,
        transport: "http",
        httpUrl: "https://mcp.example.com/mcp",
      },
    ],
    ["/api/contacts/resolve", { email: `resolved-${n}@example.com`, name: `Resolved ${n}` }],
  ]
  const seedStatus: string[] = []
  for (const [token, tag] of [
    [fx.tokenA, "a"],
    [fx.tokenB, "b"],
  ] as const) {
    for (const [path, body] of seed(`${tag}${crypto.randomUUID().slice(0, 6)}`)) {
      const res = await app.request(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      seedStatus.push(`${tag} ${res.status} ${path}`)
      if (tag === "a" && path === "/api/document-templates" && res.ok) {
        templateA = ((await res.clone().json()) as { data: { id: string } }).data.id
      }
    }
  }
  console.log(`two-org sweep seeds: ${seedStatus.join(" | ")}`)

  // Harvest.
  const idsB = new Set<string>()
  for (const path of routes("GET").filter((p) => !p.includes(":"))) {
    const a = await call("GET", path, fx.tokenA)
    const b = await call("GET", path, fx.tokenB)
    if (a.status >= 200 && a.status < 300)
      for (const m of a.body.match(UUID_RE) ?? []) orgAIds.add(m.toLowerCase())
    if (b.status >= 200 && b.status < 300)
      for (const m of b.body.match(UUID_RE) ?? []) idsB.add(m.toLowerCase())
  }
  orgAIds.add(fx.orgA.secretThreadId)
  orgAIds.add(fx.userA.id)
  for (const id of idsB) orgAIds.delete(id)
  // An org id itself is not an object id worth probing with.
  orgAIds.delete(fx.orgA.id)
  orgAIds.delete(fx.orgB.id)
}, 600_000)

afterAll(async () => {
  // A coverage line per run, so a sweep that silently probed nothing shows.
  console.log(
    `two-org sweep: ${orgAIds.size} org-A ids, ${readPairsChecked} read pairs on ${readRoutesChecked.size} GET routes, ${writePairsChecked} write pairs`,
  )
  console.log(`two-org sweep GET routes covered: ${[...resourceIds.keys()].join(" ")}`)
  const uncovered = routes("GET").filter((p) => p.includes(":") && !readRoutesChecked.has(p))
  console.log(`two-org sweep GET routes with no org-A object found: ${uncovered.join(" ")}`)
  await releaseTestLock()
})

describe("two-org isolation sweep (every org-scoped route, read and write)", () => {
  it("harvests org-A ids to probe with", () => {
    expect(orgAIds.size).toBeGreaterThan(3)
  })

  it("no GET route answers org B with an org-A object (positive control first)", async () => {
    for (const path of routes("GET").filter((p) => p.includes(":"))) {
      if (paramNames(path).length === 0) continue
      for (const id of orgAIds) {
        const target = fill(path, id)
        const a = await call("GET", target, fx.tokenA)
        if (a.status < 200 || a.status >= 300) continue
        // Positive control: org A reads this object here. Routes whose answer
        // names the id are also the resources the write phase targets.
        if (a.body.toLowerCase().includes(id)) {
          const list = resourceIds.get(path) ?? []
          list.push(id)
          resourceIds.set(path, list)
        }
        readPairsChecked += 1
        readRoutesChecked.add(path)
        const b = await call("GET", target, fx.tokenB)
        if (b.status < 200 || b.status >= 300) continue
        const body = b.body.toLowerCase()
        const leaked = [...orgAIds].filter((x) => x !== id && body.includes(x))
        // The requested id itself in B's answer is a leak unless the answer is
        // exactly what B gets for an id that never existed (the route only
        // echoes its path parameter): same status, same body with the id masked.
        if (body.includes(id)) {
          const unknown = crypto.randomUUID()
          const u = await call("GET", fill(path, unknown), fx.tokenB)
          if (u.status !== b.status || masked(u.body, unknown) !== masked(b.body, id))
            leaked.unshift(id)
        }
        if (leaked.length > 0) {
          readLeaks.push(
            `${b.status} GET ${path} id=${id} leaked=${leaked.slice(0, 3).join(",")} body=${b.body.slice(0, 200)}`,
          )
        }
      }
    }
    expect(readPairsChecked).toBeGreaterThan(3)
    expect(readLeaks).toEqual([])
  }, 900_000)

  it("the documents routes (ids in query and body) never serve org B an org-A template", async () => {
    expect(templateA).toMatch(/^[0-9a-f-]{36}$/)
    const query = `/api/documents/templates?app=${SWEEP_RECORD_TYPE.app}&entity=${SWEEP_RECORD_TYPE.entity}`
    // Positive control: A lists its own template for the record type.
    const a = await call("GET", query, fx.tokenA)
    expect(a.status).toBe(200)
    expect(a.body).toContain(templateA)
    const b = await call("GET", query, fx.tokenB)
    expect(b.status).toBe(200)
    expect([...orgAIds, templateA].filter((id) => b.body.toLowerCase().includes(id))).toEqual([])

    const print = await app.request("/api/documents/print", {
      method: "POST",
      headers: { Authorization: `Bearer ${fx.tokenB}`, "content-type": "application/json" },
      body: JSON.stringify({
        ...SWEEP_RECORD_TYPE,
        recordId: crypto.randomUUID(),
        templateIds: [templateA],
      }),
    })
    expect(print.status).toBeGreaterThanOrEqual(400)
    expect((await print.text()).toLowerCase()).not.toContain(templateA)
    const before = await call("GET", `/api/document-templates/${templateA}`, fx.tokenA)
    expect(before.status).toBe(200)
    for (const [method, path] of [
      ["PATCH", `/api/document-templates/${templateA}`],
      ["POST", `/api/document-templates/${templateA}/archive`],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { Authorization: `Bearer ${fx.tokenB}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "taken over" }),
      })
      expect(res.status).toBe(404)
    }
    const after = await call("GET", `/api/document-templates/${templateA}`, fx.tokenA)
    expect(after.body).toBe(before.body)
  }, 120_000)

  it("no write route lets org B change an org-A object, and A's object is unchanged", async () => {
    const writeMethods = ["PATCH", "PUT", "POST", "DELETE"]
    for (const method of writeMethods) {
      for (const path of routes(method).filter((p) => p.includes(":"))) {
        // The GET resource this write acts on: the longest GET pattern that is
        // a prefix of the write path up to (and including) its first parameter.
        const firstParamEnd = path.search(/:[A-Za-z_]+/)
        const head = path.slice(0, firstParamEnd)
        let ids: string[] = []
        let readRoute = ""
        for (const [getPath, found] of resourceIds) {
          if (getPath.startsWith(head) && getPath.slice(head.length).match(/^:[A-Za-z_]+$/)) {
            ids = found
            readRoute = getPath
          }
        }
        for (const id of ids) {
          writePairsChecked += 1
          const before = await call("GET", fill(readRoute, id), fx.tokenA)
          const b = await call(method, fill(path, id), fx.tokenB)
          const after = await call("GET", fill(readRoute, id), fx.tokenA)
          if ((b.status >= 200 && b.status < 300) || after.body !== before.body) {
            writeLeaks.push(
              `${b.status} ${method} ${path} id=${id} changed=${after.body !== before.body} body=${b.body.slice(0, 160)}`,
            )
          }
        }
      }
    }
    expect(writeLeaks).toEqual([])
  }, 900_000)
})
