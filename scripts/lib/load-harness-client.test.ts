// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  HARNESS_HEADERS,
  HarnessClient,
  harnessSignature,
  refreshCookieFrom,
  seedLoadOrgs,
} from "./load-harness-client"

const ROOT = join(import.meta.dir, "../..")
const KEY = "k".repeat(48)

/** A box's demo door, as far as seeding needs it: signed starts, the sink read, verify. */
function fakeBox() {
  const orgsByKey = new Map<string, { orgId: string; userId: string; code: string | null }>()
  const byOrg = new Map<string, { code: string | null }>()
  let sessions = 0
  const seen = new Set<string>()
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname
    const h = new Headers(init.headers)
    const body = typeof init.body === "string" ? init.body : ""
    const nonce = h.get(HARNESS_HEADERS.nonce) ?? ""
    const ts = Number(h.get(HARNESS_HEADERS.timestamp))
    const sig = harnessSignature(KEY, {
      method: init.method ?? "GET",
      path,
      timestamp: ts,
      nonce,
      body,
    })
    if (sig !== h.get(HARNESS_HEADERS.signature) || seen.has(nonce)) return json(403, { error: {} })
    seen.add(nonce)
    if (path === "/api/demo/orgs") {
      const input = JSON.parse(body) as { signupKey: string; email: string }
      if (!input.email.endsWith("@load.invalid")) return json(422, { error: {} })
      let org = orgsByKey.get(input.signupKey)
      if (!org) {
        org = { orgId: crypto.randomUUID(), userId: crypto.randomUUID(), code: "123456" }
        orgsByKey.set(input.signupKey, org)
        byOrg.set(org.orgId, org)
      }
      sessions++
      return json(
        201,
        {
          data: {
            orgId: org.orgId,
            userId: org.userId,
            state: "ready",
            accessToken: `at${sessions}`,
          },
        },
        { "set-cookie": `liaison_rt=rt${sessions}; HttpOnly; Path=/api/auth` },
      )
    }
    const sink = /^\/api\/demo\/harness\/orgs\/([^/]+)\/sink$/.exec(path)
    if (sink) {
      const org = byOrg.get(sink[1]!)
      return org ? json(200, { data: { demoCode: org.code, effects: [] } }) : json(404, {})
    }
    if (path === "/api/demo/verify") {
      const token = h.get("authorization")?.replace("Bearer ", "")
      const org = [...byOrg.values()].find(
        (o) => o.code === (JSON.parse(body) as { code: string }).code,
      )
      if (!token || !org) return json(422, {})
      org.code = null
      return json(200, { data: { verified: true } })
    }
    return json(404, {})
  }
  return { fetchImpl, orgs: () => orgsByKey.size }
}

describe("seedLoadOrgs", () => {
  it("--orgs 3 creates 3 load orgs, each verified with its sunk code and with its own sessions, and is idempotent on re-run", async () => {
    const box = fakeBox()
    const client = new HarnessClient("http://box.test/", KEY, box.fetchImpl)
    const opts = { orgs: 3, prefix: "load-", seed: "s1", sessions: 2, needs: ["support"] }
    const first = await seedLoadOrgs(client, opts)
    expect(first.length).toBe(3)
    expect(box.orgs()).toBe(3)
    for (const org of first) {
      expect(org.verified).toBe(true)
      expect(org.pooled).toBe(true)
      expect(org.sessions.length).toBe(2)
      expect(org.sessions[0]!.accessToken).not.toBe(org.sessions[1]!.accessToken)
      expect(org.sessions[0]!.refreshCookie).toMatch(/^liaison_rt=rt\d+$/)
    }
    const again = await seedLoadOrgs(client, opts)
    expect(again.map((o) => o.orgId)).toEqual(first.map((o) => o.orgId))
    expect(box.orgs()).toBe(3)
    const other = await seedLoadOrgs(client, { ...opts, seed: "s2", orgs: 1 })
    expect(first.map((o) => o.orgId)).not.toContain(other[0]!.orgId)
  })

  it("D4: a request to a box that never answers is abandoned at the timeout", async () => {
    const hang = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })
    const client = new HarnessClient("http://box.test", KEY, hang, 50)
    const t0 = Date.now()
    await expect(client.sink("o")).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(3_000)
  })

  it("refuses a key shorter than the box accepts", () => {
    expect(() => new HarnessClient("http://box.test", "short")).toThrow()
  })
})

describe("the signature", () => {
  it("is the server's: same headers, same signed fields, in the TS client and the k6 client", () => {
    const server = readFileSync(join(ROOT, "apps/api/src/lib/load-harness.ts"), "utf8")
    const k6 = readFileSync(join(ROOT, "qa/load/lib/harness.js"), "utf8")
    for (const name of Object.values(HARNESS_HEADERS)) {
      expect(server).toContain(`"${name}"`)
      expect(k6).toContain(`"${name}"`)
    }
    // METHOD \n path \n ts \n nonce \n sha256hex(body) in all three.
    expect(server).toMatch(
      /fields\.method\.toUpperCase\(\),\s*fields\.path,\s*String\(fields\.timestamp\),\s*fields\.nonce,\s*bodyHash,\s*\]\.join\("\\n"\)/,
    )
    expect(k6).toContain('[method.toUpperCase(), path, ts, n, bodyHash].join("\\n")')
    expect(
      harnessSignature(KEY, { method: "get", path: "/p", timestamp: 1, nonce: "n", body: "" }),
    ).toBe(harnessSignature(KEY, { method: "GET", path: "/p", timestamp: 1, nonce: "n", body: "" }))
  })

  it("the k6 visitor refreshes a fresh workspace's session before its first authed call", () => {
    // The seed behind a fresh start raises the visitor's permission version, so
    // the start's token is stale once the workspace is ready: without this
    // refresh every fresh visitor's verify answered one 401 (launch runs:
    // http_401 = fresh visitors that reached ready, exactly).
    const k6 = readFileSync(join(ROOT, "qa/load/a9-deploy-under-load.js"), "utf8")
    const visitor = k6.slice(k6.indexOf("function visitor()"))
    const refresh = visitor.indexOf("if (!pooled) bearer(HOST, sess, true)")
    expect(refresh).toBeGreaterThan(visitor.indexOf("const sess = {"))
    expect(refresh).toBeLessThan(visitor.indexOf("/api/demo/verify"))
  })

  it("reads the refresh cookie out of Set-Cookie, whatever its prefix", () => {
    expect(refreshCookieFrom(["a=b; Path=/", "__Host-liaison_rt=xyz; Secure; HttpOnly"])).toBe(
      "__Host-liaison_rt=xyz",
    )
    expect(refreshCookieFrom(["liaison_rt=; Max-Age=0"])).toBeNull()
  })
})
