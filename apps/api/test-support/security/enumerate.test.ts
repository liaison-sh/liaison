// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The attack-surface enumerator, on fixtures small enough to state the answer:
// a Hono app with three routes (one public) and a source file with two
// privileged database sites (one taking its org id from a parameter).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import {
  classifyOrgIdExpression,
  concretePath,
  enumerateCliCommands,
  enumeratePrivilegedSites,
  enumerateRawSql,
  enumerateRedisKeys,
  enumerateRoutes,
  enumerateSearchFilters,
  RouteRegistrationRecorder,
  type SurfaceRow,
} from "./enumerate"

class MissingScope extends Error {
  constructor(readonly missingScope: string) {
    super(`missing ${missingScope}`)
  }
}

const requireAuth = createMiddleware(async (c, next) => {
  if (!c.req.header("authorization")) throw new HTTPException(401, { message: "unauthenticated" })
  await next()
})

const requireScope = (scope: string) =>
  createMiddleware<{ Variables: { scopes?: string[] } }>(async (c, next) => {
    const scopes = c.get("scopes") ?? []
    if (!scopes.includes(scope)) throw new MissingScope(scope)
    await next()
  })

/** Three routes: one public, one behind auth, one behind auth and a scope. */
function fixtureApp(opts: { withAdminRoute: boolean }) {
  const app = new Hono()
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    if (err instanceof MissingScope) return c.json({ error: { message: err.message } }, 403)
    return c.json({ error: { message: "internal" } }, 500)
  })
  app.get("/health", (c) => c.json({ ok: true }))
  const items = new Hono().get("/:id", (c) => c.json({ id: c.req.param("id") }))
  app.use("/api/*", requireAuth)
  app.route("/api/items", items)
  if (opts.withAdminRoute) {
    app.post("/api/admin/purge", requireScope("kernel:org:admin"), (c) => c.json({ purged: true }))
  }
  return app
}

const byId = (rows: SurfaceRow[]) => new Map(rows.map((r) => [r.id, r]))

describe("enumerateRoutes on a fixture app", () => {
  const recorder = new RouteRegistrationRecorder()
  let rows: SurfaceRow[] = []

  beforeAll(async () => {
    await recorder.install()
    const app = fixtureApp({ withAdminRoute: true })
    recorder.uninstall()
    rows = await enumerateRoutes(app, { variant: "fixture", recorder })
  })
  afterAll(() => recorder.uninstall())

  it("lists exactly the three endpoints, middleware excluded", () => {
    expect(rows.map((r) => r.id).sort()).toEqual([
      "route:GET /api/items/:id",
      "route:GET /health",
      "route:POST /api/admin/purge",
    ])
  })

  it("classifies the unauthenticated route as public and the others as authenticated", () => {
    const m = byId(rows)
    expect(m.get("route:GET /health")?.attrs.auth).toBe("public")
    expect(m.get("route:GET /api/items/:id")?.attrs.auth).toBe("authenticated")
    expect(m.get("route:POST /api/admin/purge")?.attrs.auth).toBe("authenticated")
  })

  it("recovers the scope a route's own middleware requires", () => {
    const m = byId(rows)
    expect(m.get("route:POST /api/admin/purge")?.attrs.scopes).toEqual(["kernel:org:admin"])
    expect(m.get("route:GET /api/items/:id")?.attrs.scopes).toEqual([])
  })

  it("points each endpoint at its definition and mount site in this file", () => {
    const items = byId(rows).get("route:GET /api/items/:id")
    expect(String(items?.attrs.definition)).toMatch(/enumerate\.test\.ts:\d+$/)
    expect(String(items?.attrs.mount)).toMatch(/enumerate\.test\.ts:\d+$/)
    expect(items?.attrs.mountPrefix).toBe("/api/items")
  })

  it("changes the count when a route is removed (mutation)", async () => {
    const without = await enumerateRoutes(fixtureApp({ withAdminRoute: false }))
    expect(without).toHaveLength(2)
    expect(without.map((r) => r.id)).not.toContain("route:POST /api/admin/purge")
  })

  it("reports a gate that depends on the path value", async () => {
    const app = new Hono()
    app.use("/files/*", async (c, next) => {
      // a bypass for one shape of segment only
      if (/^\/files\/\d+\.\d+\.\d+$/.test(c.req.path)) return next()
      return requireAuth(c, next)
    })
    app.get("/files/:version", (c) => c.text("ok"))
    const [row] = await enumerateRoutes(app)
    expect(row.attrs.auth).toBe("path-dependent")
  })

  it("builds request paths the route accepts", () => {
    expect(concretePath("/a/:id/b/*")).toBe("/a/00000000-0000-4000-8000-000000000001/b/sample")
    expect(concretePath("/a/:n{[0-9]+}")).toBe("/a/1")
    expect(concretePath("/apps/:name/:version/ui.js", -1)).toBe("/apps/sample/1.0.0/ui.js")
  })
})

const PRIV_FIXTURE = `
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"

export const routes = new Hono().get("/things", async (c) => {
  const orgId = c.get("orgId")
  return withPrivilegedDb(orgId, "things:list", (tx) => tx.select())
})

export async function purgeOrg(orgId: string) {
  await withPrivilegedDb(orgId, "things:purge", (tx) => tx.delete())
}
`

describe("enumeratePrivilegedSites on a fixture file", () => {
  const file = `${import.meta.dir}/__virtual__/priv-fixture.ts`
  const rows = enumeratePrivilegedSites([file], import.meta.dir, new Map([[file, PRIV_FIXTURE]]))

  it("finds both call sites", () => {
    expect(rows).toHaveLength(2)
  })

  it("classifies the org id source of each", () => {
    const [route, purge] = rows
    expect(route.attrs.orgIdSource).toBe("auth-context")
    expect(route.attrs.enclosing).toBe("routes.GET /things")
    expect(route.attrs.inRouteHandler).toBe(true)
    expect(purge.attrs.orgIdSource).toBe("caller-input")
    expect(purge.attrs.enclosing).toBe("purgeOrg")
    expect(purge.attrs.inRouteHandler).toBe(false)
  })

  it("gives stable ids without line numbers", () => {
    expect(rows.map((r) => r.id)).toEqual([
      "priv:__virtual__/priv-fixture.ts#routes.GET /things#withPrivilegedDb",
      "priv:__virtual__/priv-fixture.ts#purgeOrg#withPrivilegedDb",
    ])
  })

  it("counts one fewer site when one is removed (mutation)", () => {
    const mutated = PRIV_FIXTURE.replace(/await withPrivilegedDb\(orgId, "things:purge".*\n/, "\n")
    const again = enumeratePrivilegedSites([file], import.meta.dir, new Map([[file, mutated]]))
    expect(again).toHaveLength(1)
  })

  it("marks withSystemDb as carrying no org", () => {
    const text = `export async function sweep() { await withSystemDb("sweep", (db) => db.select()) }`
    const [row] = enumeratePrivilegedSites([file], import.meta.dir, new Map([[file, text]]))
    expect(row.attrs.orgIdSource).toBe("no-org")
  })

  it("classifies job payloads and literals", () => {
    const ts = require("typescript") as typeof import("typescript")
    const sf = ts.createSourceFile(
      "x.ts",
      `function h(job: Job) { use(job.orgId); use("00000000-0000-0000-0000-000000000000") }`,
      ts.ScriptTarget.Latest,
      true,
    )
    const args: import("typescript").Expression[] = []
    const visit = (n: import("typescript").Node) => {
      if (ts.isCallExpression(n) && n.expression.getText(sf) === "use") args.push(n.arguments[0])
      ts.forEachChild(n, visit)
    }
    visit(sf)
    expect(classifyOrgIdExpression(args[0]).source).toBe("job/system")
    expect(classifyOrgIdExpression(args[1]).source).toBe("literal")
  })
})

describe("enumerateRawSql on a fixture file", () => {
  const file = `${import.meta.dir}/__virtual__/raw-fixture.ts`
  const text = `
export async function f(tx: Tx, name: string) {
  await tx.execute(sql.raw("SET LOCAL ROLE x"))
  await tx.execute(sql.raw(\`SELECT * FROM t WHERE name = '\${name}'\`))
  await client.unsafe("SELECT 1")
  await tx.execute(sql\`SELECT \${name}\`)
}`
  const rows = enumerateRawSql([file], import.meta.dir, new Map([[file, text]]))

  it("finds the raw and unsafe sites, not the parameterised tagged template", () => {
    expect(rows.map((r) => r.attrs.form)).toEqual(["sql.raw", "sql.raw", "client.unsafe"])
  })

  it("flags the interpolated one as dynamic, naming what is interpolated", () => {
    expect(rows.map((r) => r.attrs.dynamic)).toEqual([false, true, false])
    expect(rows[1].attrs.interpolations).toEqual(["name"])
  })
})

describe("enumerateSearchFilters on a fixture file", () => {
  const file = `${import.meta.dir}/__virtual__/search-fixture.ts`
  const text = `
import { getMeili } from "~/infra/search/client"
function meiliEscape(v: string) { return v.replace(/"/g, '\\"') }
export async function scoped(orgId: string, q: string) {
  const filter = \`org_id = "\${meiliEscape(orgId)}" AND app = "kernel"\`
  return getMeili().index("x").search(q, { filter, limit: 5 })
}
export async function viaBuilder(ctx: Ctx, q: string) {
  return getMeili().index("x").search(q, { filter: buildPermissionFilter(ctx) })
}
export async function unscoped(index: Index, wide: boolean) {
  const filter = wide ? "has_vector = true" : \`app = "kernel"\`
  await index.getDocuments({ filter, limit: 10 })
  await index.deleteDocuments(["a", "b"])
}
export function rawClause(job: Job) {
  return \`org_id = "\${job.orgId}"\`
}
export async function notMeili(client: GitLab) {
  return client.search({ scope: "issues" })
}
`
  const rows = enumerateSearchFilters([file], import.meta.dir, new Map([[file, text]]))
  const calls = rows.filter((r) => r.attrs.form !== "filter-builder")
  const builders = rows.filter((r) => r.attrs.form === "filter-builder")

  it("lists every call on a Meilisearch index, and nothing else's search", () => {
    expect(calls.map((r) => [r.attrs.enclosing, r.attrs.form])).toEqual([
      ["scoped", "index.search"],
      ["viaBuilder", "index.search"],
      ["unscoped", "index.getDocuments"],
      ["unscoped", "index.deleteDocuments"],
    ])
  })

  it("says whether each call's filter pins an org", () => {
    expect(calls.map((r) => r.attrs.orgFilter)).toEqual([
      "inline",
      "builder buildPermissionFilter()",
      "none",
      "none",
    ])
  })

  it("lists each org clause with its org id's source and whether it is escaped", () => {
    expect(builders.map((r) => [r.attrs.enclosing, r.attrs.orgIdSource, r.attrs.escaped])).toEqual([
      ["scoped", "caller-input", true],
      ["rawClause", "job/system", false],
    ])
  })
})

describe("enumerateRedisKeys on a fixture file", () => {
  const file = `${import.meta.dir}/__virtual__/redis-fixture.ts`
  const text = `
import { redis } from "~/lib/redis"
export function attemptsKey(userId: string): string {
  return \`auth:attempts:\${userId}\`
}
export async function count(orgId: string, userId: string) {
  await redis.incr(attemptsKey(userId))
  const seqKey = \`ws:seq:\${orgId}\`
  await redis.multi().set(seqKey, "1", "EX", 60).expire("global:lock", 5).exec()
  await redis.eval("return 1", 2, "k1", \`k2:\${orgId}\`, "arg")
  const cache = new Map<string, string>()
  cache.get("not-redis")
}
export async function viaParam(client: Redis, key: string) {
  await client.del(key)
}
`
  const rows = enumerateRedisKeys([file], import.meta.dir, new Map([[file, text]]))

  it("lists every command on a Redis client, chains and typed parameters included", () => {
    expect(rows.map((r) => r.attrs.command)).toEqual(["incr", "expire", "set", "eval", "del"])
  })

  it("names each key, its builder's template, and whether an org id is in it", () => {
    // A chain is walked outside in: the expire wraps the set.
    const [incr, expire, set, evalRow, del] = rows
    expect(incr?.attrs.builder).toEqual(["attemptsKey"])
    expect(incr?.attrs.builderTemplate).toEqual([`\`auth:attempts:\${userId}\``])
    expect(incr?.attrs.orgInKey).toBe(false)
    expect(set?.attrs.key).toEqual([`seqKey = \`ws:seq:\${orgId}\``])
    expect(set?.attrs.keyHead).toEqual(["ws:seq:"])
    expect(set?.attrs.orgInKey).toBe(true)
    expect(expire?.attrs.key).toEqual(['"global:lock"'])
    expect(evalRow?.attrs.key).toEqual(['"k1"', `\`k2:\${orgId}\``])
    expect(evalRow?.attrs.spliced).toEqual(["orgId"])
    expect(del?.attrs.key).toEqual(["key"])
  })
})

describe("the org-id caller trace on fixture files", () => {
  const dir = `${import.meta.dir}/__fixtures__/org-trace`
  const files = ["db.ts", "service.ts", "routes.ts", "other.ts"].map((f) => `${dir}/${f}`)
  const traceOf = (rows: SurfaceRow[], enclosing: string) =>
    String(rows.find((r) => r.attrs.enclosing === enclosing)?.attrs.orgIdTrace ?? "")
  const rows = enumeratePrivilegedSites(files)

  it("follows a parameter to a route that passes the auth context", () => {
    expect(traceOf(rows, "loadThing")).toBe("traced: callers pass auth-context")
  })

  it("follows a default dependency, (deps.load ?? loadOther)(orgId), to its caller", () => {
    expect(traceOf(rows, "loadOther")).toBe("traced: callers pass auth-context")
  })

  it("names the request value a route passes, and where", () => {
    const t = traceOf(rows, "fromQuery")
    expect(t).toStartWith("untraced: passes caller-input")
    expect(t).toContain('c.req.query("org")')
    expect(t).toContain("org-trace/routes.ts:13")
  })

  it("does not count a same-named function in another module as a caller", () => {
    expect(traceOf(rows, "loadThing")).not.toContain("other.ts")
  })

  it("stops at a function kept in a registry, until the registry is reviewed", () => {
    expect(traceOf(rows, "registered")).toStartWith("untraced: fn ")
    const key = "apps/api/test-support/security/__fixtures__/org-trace/service.ts#register"
    const reviewed = enumeratePrivilegedSites(files, undefined, undefined, {
      reviewedRegistries: { [key]: "fixture" },
    })
    expect(traceOf(reviewed, "registered")).toBe(`traced: callers pass reviewed registry ${key}`)
  })

  it("stops at a reviewed origin", () => {
    const origin = "apps/api/test-support/security/__fixtures__/org-trace/routes.ts#GET /query"
    const reviewed = enumeratePrivilegedSites(files, undefined, undefined, {
      reviewedOrigins: { [origin]: "fixture" },
    })
    expect(traceOf(reviewed, "fromQuery")).toBe(`traced: callers pass reviewed origin ${origin}`)
  })

  it("follows a factory's conditional return and a spread of a parameter to its callers", () => {
    const spreadRows = enumeratePrivilegedSites([`${dir}/db.ts`, `${dir}/spread-factory.ts`])
    expect(traceOf(spreadRows, "spreadSite")).toBe("traced: callers pass auth-context")
  })

  describe("job dispatch with run options, and forwarding wrappers", () => {
    const dispatchRows = enumeratePrivilegedSites([`${dir}/db.ts`, `${dir}/dispatch.ts`])

    it("takes run options beside a job payload, handler(job.data, { signal }), as no org", () => {
      expect(traceOf(dispatchRows, "jobToolHandler")).toBe(
        "traced: callers pass run options beside a job payload",
      )
    })

    it("still stops at an object without the org id beside anything but a job payload", () => {
      expect(traceOf(dispatchRows, "plainToolHandler")).toStartWith(
        "untraced: no orgId in the object passed",
      )
    })

    it("follows (...args) => inner(...args) to the wrapper's callers", () => {
      expect(traceOf(dispatchRows, "forwardedInner")).toBe("traced: callers pass auth-context")
      const t = traceOf(dispatchRows, "forwardedQuery")
      expect(t).toStartWith("untraced: passes caller-input")
      expect(t).toContain("forwards to forwardedQuery")
    })
  })
})

describe("enumerateCliCommands on this checkout", () => {
  // The USAGE table moved from cli/index.ts to cli/main.ts; an enumerator that
  // still read only index.ts listed zero commands and nobody noticed.
  const rows = enumerateCliCommands()

  it("lists the operator commands from the USAGE table wherever the CLI keeps it", () => {
    const ids = rows.map((r) => r.id)
    expect(ids).toContain("cli:config apply")
    expect(ids).toContain("cli:agent ask")
    expect(rows.every((r) => r.location.startsWith("apps/api/src/cli/"))).toBe(true)
  })
})
