// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The remote CLI against a fake Liaison (Bun.serve): sign-in through the
// device flow, refresh on 401 with the rotated cookie, the 0600 credentials
// file, push/check, a publish that waits for an approval, the config apply
// refusals, and the interface consent's typed confirmation.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as apps from "./apps"
import { parseArgs } from "./args"
import * as auth from "./auth"
import { planConfig } from "./config-apply"
import { Client } from "./http"
import { readCredentials } from "./store"

const B = new Set(["wait", "yes", "admin", "config", "no-browser", "withdraw", "fresh", "verbose"])
const args = (...a: string[]) => parseArgs(a, B)

function token(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${enc({ alg: "none" })}.${enc({ exp: Math.floor(Date.now() / 1000) + 900, ...payload })}.sig`
}

/** What the fake server reads from a request body. */
interface Body {
  clientId?: string
  scopes?: string[]
  files?: Record<string, string>
  mode?: string
  params?: { title?: string }
  n?: number
  approved?: boolean
  confirm?: string
}

interface Seen {
  method: string
  path: string
  body: Body
  auth: string | null
  cookie: string | null
}
let seen: Seen[] = []
let server: ReturnType<typeof Bun.serve>
let host = ""
let dir = ""
let pollsBeforeApproval = 1
let approvalPolls = 0
let rejectNextAuth = false
let accessN = 0
let files: Record<string, string> = {}
let latestN = 1
let lastScopes: string[] = []
const dirs: string[] = []

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body: Body = req.method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Body)
      seen.push({
        method: req.method,
        path: url.pathname,
        body,
        auth: req.headers.get("authorization"),
        cookie: req.headers.get("cookie"),
      })
      const p = url.pathname
      if (p === "/api/auth/device-flow/initiate") {
        lastScopes = body.scopes ?? []
        return json({
          deviceCode: "dc",
          userCode: "ABCD-EFGH",
          verificationUri: `${host}/auth/device?code=ABCD-EFGH`,
          expiresIn: 60,
        })
      }
      if (p === "/api/auth/device-flow/poll/dc") {
        if (pollsBeforeApproval-- > 0) return json({ status: "authorization_pending" })
        return json(
          { status: "approved", accessToken: token({ orgId: "org-1", scopes: lastScopes }) },
          200,
          {
            "set-cookie": "liaison_rt=rt-1; HttpOnly; SameSite=Strict; Path=/api/auth",
          },
        )
      }
      if (p === "/api/auth/refresh") {
        if (req.headers.get("cookie") !== `liaison_rt=rt-${accessN + 1}`)
          return new Response("{}", { status: 401 })
        accessN++
        return json(
          {
            accessToken: token({
              orgId: "org-1",
              n: accessN,
              scopes: ["kernel:apps:build", "kernel:apps:admin"],
            }),
          },
          200,
          {
            "set-cookie": `liaison_rt=rt-${accessN + 1}; HttpOnly; Path=/api/auth`,
          },
        )
      }
      if (rejectNextAuth) {
        rejectNextAuth = false
        return new Response(JSON.stringify({ error: { message: "expired" } }), { status: 401 })
      }
      if (p === "/api/users/me") return json({ email: "ada@example.com" })
      if (p === "/api/apps/builder/drafts" && req.method === "POST") {
        files = { "app.manifest.json": '{"name":"notes-oabc"}', "handlers.ts": "export default {}" }
        latestN = 1
        return json({ draftId: "d-1", appName: "notes-oabc", n: 1, files }, 201)
      }
      if (p === "/api/apps/builder/drafts/d-1" && req.method === "GET") {
        return json({
          draft: { id: "d-1", baseName: "notes", status: "draft" },
          appName: "notes-oabc",
          version: { n: latestN, files },
        })
      }
      if (p === "/api/apps/builder/drafts/d-1/files") {
        files = body.files ?? {}
        latestN++
        return json({ draftId: "d-1", n: latestN, files: Object.keys(files) })
      }
      if (p === "/api/apps/builder/drafts/d-1/check") {
        const ok = !files["handlers.ts"]!.includes("BROKEN")
        return json({
          ok,
          errors: ok ? [] : [{ file: "handlers.ts", line: 3, message: "Cannot find name 'x'" }],
          typecheck: null,
          appVersion: "0.1.0",
        })
      }
      if (p === "/api/apps/builder/drafts/d-1/preview") {
        return json({
          ok: true,
          result: { items: [{ title: body.params?.title ?? "x" }] },
          logs: [],
        })
      }
      if (p === "/api/apps/builder/drafts/d-1/publish")
        return json(
          {
            status: "pending_approval",
            approvalId: "ap-1",
            summary: { lines: ["Installs notes-oabc 0.1.0"] },
          },
          202,
        )
      if (p === "/api/approvals/ap-1/result") {
        approvalPolls++
        return json(
          approvalPolls < 2
            ? { status: "pending", result: null }
            : { status: "approved", result: { appVersion: "0.1.0" } },
        )
      }
      if (p === "/api/apps/builder/drafts/d-1/status") {
        return json({
          draftId: "d-1",
          title: "Notes",
          status: "published",
          appName: "notes-oabc",
          latestVersion: latestN,
          latestBuild: { ok: true },
          installed: {
            version: "0.1.1",
            sha256: "a".repeat(64),
            draftVersion: 3,
            grantedScopes: [],
            grantedDomains: [],
          },
          publishes: [
            { version: "0.1.1", n: 3, at: "2026-11-27T01:00:00Z", draftId: "d-1" },
            { version: "0.1.0", n: 2, at: "2026-11-27T00:00:00Z", draftId: "d-1" },
          ],
        })
      }
      if (p === "/api/apps/builder/drafts/d-1/restore") return json({ n: latestN + 1 })
      if (p === "/api/apps/notes-oabc/ui-approval") return json({ ok: true })
      if (p === "/api/approvals") return json([])
      return new Response(JSON.stringify({ error: { message: `no route ${p}` } }), { status: 404 })
    },
  })
  host = `http://localhost:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liaison-cli-test-"))
  dirs.push(dir)
  process.env.LIAISON_CONFIG_DIR = join(dir, "config")
  process.env.LIAISON_CREDENTIAL_STORE = "file"
  process.env.LIAISON_CLI_POLL_MS = "5"
  delete process.env.LIAISON_PROFILE
  seen = []
  pollsBeforeApproval = 1
  approvalPolls = 0
  accessN = 0
})

function capture() {
  const out: string[] = []
  const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) }
  return { out, io }
}

async function signIn(...extra: string[]) {
  const { io } = capture()
  await auth.login(args("--host", host, "--no-browser", ...extra), io)
}

describe("login", () => {
  it("declares only app building and logs by default, never kernel:apps:admin", async () => {
    const { out, io } = capture()
    await auth.login(args("--host", host, "--no-browser"), io)
    const init = seen.find((s) => s.path.endsWith("/initiate"))!
    expect(init.body.clientId).toBe("liaison-cli")
    expect(init.body.scopes).toEqual(["kernel:apps:build", "kernel:apps:logs"])
    expect(out.join("\n")).toContain("ABCD-EFGH")
    expect(out.join("\n")).toContain("Signed in to")
    expect(out.join("\n")).toContain("ada@example.com")
  })

  it("--admin and --config add their scopes, explicitly", async () => {
    await signIn("--admin")
    expect(seen.find((s) => s.path.endsWith("/initiate"))!.body.scopes).toContain(
      "kernel:apps:admin",
    )
    seen = []
    pollsBeforeApproval = 0
    await signIn("--config", "--profile", "cfg")
    const scopes = seen.find((s) => s.path.endsWith("/initiate"))!.body.scopes ?? []
    expect(scopes).toContain("kernel:roles:admin")
    expect(scopes).toContain("kernel:skills:write")
  })

  it("keeps the sign-in in a 0600 file when there is no keychain, with the refresh cookie", async () => {
    await signIn()
    const path = join(process.env.LIAISON_CONFIG_DIR!, "credentials.json")
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readCredentials("default")?.refreshCookie).toEqual({ name: "liaison_rt", value: "rt-1" })
  })

  it("refreshes on a 401 and stores the rotated cookie", async () => {
    await signIn()
    const client = new Client("default", host)
    rejectNextAuth = true
    const me = await client.request<{ email: string }>("GET", "/api/users/me")
    expect(me.email).toBe("ada@example.com")
    expect(seen.find((s) => s.path === "/api/auth/refresh")?.cookie).toBe("liaison_rt=rt-1")
    expect(readCredentials("default")?.refreshCookie?.value).toBe("rt-2")
  })

  it("refuses plain http to a remote host", async () => {
    const { io } = capture()
    await expect(
      auth.login(args("--host", "http://acme.example.com", "--no-browser"), io),
    ).rejects.toThrow("plain http")
  })

  it("logout removes the sign-in", async () => {
    await signIn()
    const { io } = capture()
    await auth.logout(args(), io)
    expect(readCredentials("default")).toBeNull()
  })
})

describe("apps", () => {
  it("init writes the files and the link; push sends the whole folder and prints build errors with file:line", async () => {
    await signIn()
    const appDir = join(dir, "notes")
    const { out, io } = capture()
    await apps.init(args("notes", "--dir", appDir), io)
    expect(JSON.parse(readFileSync(join(appDir, ".liaison/app.json"), "utf8"))).toMatchObject({
      draftId: "d-1",
      appName: "notes-oabc",
    })

    writeFileSync(join(appDir, "handlers.ts"), "export default {}\n// BROKEN\n")
    const code = await apps.push(args("--dir", appDir), io)
    expect(code).toBe(1)
    const put = seen.find((s) => s.path.endsWith("/files"))!
    expect(put.body.mode).toBe("full")
    expect(Object.keys(put.body.files ?? {}).sort()).toEqual(["app.manifest.json", "handlers.ts"])
    expect(out.join("\n")).toContain("handlers.ts:3: Cannot find name 'x'")

    writeFileSync(join(appDir, "handlers.ts"), "export default {}\n")
    expect(await apps.push(args("--dir", appDir), io)).toBe(0)
  })

  it("test runs tests/*.json cases in the preview and checks expect", async () => {
    await signIn()
    const appDir = join(dir, "notes")
    const { out, io } = capture()
    await apps.init(args("notes", "--dir", appDir), io)
    writeFileSync(
      join(appDir, "tests", "add.json"),
      JSON.stringify({
        tool: "add_item",
        params: { title: "milk" },
        expect: { items: [{ title: "milk" }] },
      }),
    )
    writeFileSync(
      join(appDir, "tests", "bad.json"),
      JSON.stringify({
        tool: "add_item",
        params: { title: "a" },
        expect: { items: [{ title: "b" }] },
      }),
    )
    expect(await apps.test(args("--dir", appDir), io)).toBe(1)
    expect(out).toContain("PASS add.json tool add_item")
    expect(out).toContain("FAIL bad.json tool add_item")
  })

  it("publish --wait asks for approval and follows the card until it is approved", async () => {
    await signIn()
    const appDir = join(dir, "notes")
    const { out, io } = capture()
    await apps.init(args("notes", "--dir", appDir), io)
    expect(await apps.publish(args("--dir", appDir, "--wait"), io)).toBe(0)
    const text = out.join("\n")
    expect(text).toContain("waits for approval ap-1")
    expect(text).toContain("NOT installed until then")
    expect(text).toContain("Approved: notes-oabc 0.1.0 is installed.")
  })

  it("rollback restores the previously published draft version and publishes it through the approval", async () => {
    await signIn()
    const appDir = join(dir, "notes")
    const { io } = capture()
    await apps.init(args("notes", "--dir", appDir), io)
    await apps.rollback(args("--dir", appDir), io)
    expect(seen.find((s) => s.path.endsWith("/restore"))!.body).toEqual({ n: 2 })
    expect(seen.some((s) => s.path.endsWith("/publish"))).toBe(true)
  })

  it("ui-consent needs kernel:apps:admin, and never approves without a person (no terminal, no --yes)", async () => {
    await signIn()
    const appDir = join(dir, "notes")
    const { io } = capture()
    await apps.init(args("notes", "--dir", appDir), io)
    await expect(apps.uiConsent(args("--dir", appDir), io)).rejects.toThrow("kernel:apps:admin")

    pollsBeforeApproval = 0
    await signIn("--admin")
    const saved = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    try {
      await expect(apps.uiConsent(args("--dir", appDir), io)).rejects.toThrow(
        "person's confirmation",
      )
      expect(seen.some((s) => s.path.endsWith("/ui-approval"))).toBe(false)
      const { out, io: io2 } = capture()
      expect(await apps.uiConsent(args("--dir", appDir, "--yes"), io2)).toBe(0)
      expect(out.join("\n")).toContain("read everything that person can read")
      expect(seen.find((s) => s.path.endsWith("/ui-approval"))!.body).toEqual({
        approved: true,
        confirm: "notes-oabc",
      })
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: saved, configurable: true })
    }
  })
})

describe("config apply", () => {
  it("sends roles, agents, apps, skills and routines; refuses mail, users, secrets and unknown sections", () => {
    const ok = planConfig({
      org: { slug: "acme" },
      roles: [],
      agents: [],
      apps: [],
      skills: [],
      routines: [],
    })
    expect(ok.refused).toEqual([])
    expect(ok.sections.map((s) => s.key)).toEqual(["roles", "agents", "apps", "skills", "routines"])
    const bad = planConfig({ roles: [], mail: {}, users: [], secrets: {}, weird: 1 })
    expect(bad.refused.map((r) => r.split(":")[0])).toEqual(["mail", "users", "secrets", "weird"])
    expect(bad.refused[0]).toContain("stays server-side")
  })
})

describe("matches", () => {
  it("is a deep subset match", () => {
    expect(apps.matches({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { c: 2 }] })).toBe(true)
    expect(apps.matches({ a: 1 }, { a: 2 })).toBe(false)
  })
})

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
