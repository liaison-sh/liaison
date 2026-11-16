// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The doors of the public client action page, through the real app: the token,
// the emailed code, the proof and the one decide. Each test is named by its door
// id and fails when its protection is removed.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import type { EmailMessage, EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import { toolRegistry } from "~/modules/apps/app-registries"
import { awaitOrgApps } from "~/modules/apps/init"
import { createPortalSession, createSession } from "~/modules/auth/auth"
import { mintClientAction, revokeClientAction } from "~/modules/client-actions/mint"
import {
  ClientActionTargetsTestAccess,
  type ClientActionView,
} from "~/modules/client-actions/targets"
import { PORTAL_PREFIX, PORTAL_ROUTES } from "~/modules/portal/routes-list"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"
import { CaptureProvider, createDoorWorld, type DoorWorld, dropDoorWorld } from "./fixture"

const TARGET_APP = "doorsdocs"
const TARGET_TYPE = "contract"
const BASE = "/api/public/client-actions"
const k = (table: string) => sql(`${schemaRef("kernel")}.${table}`)

let w: DoorWorld
let previous: EmailProvider
const capture = new CaptureProvider()
let prevForce: string | undefined
let shaNow = "b".repeat(64)
let viewDelayMs = 0
let ipSeq = 1

function view(): ClientActionView {
  return {
    title: "Contrat Maison Alpha",
    senderName: "Admin",
    summary: [{ k: "Montant", v: "1 200 EUR" }],
    sourceBlocks: [{ type: "paragraph", text: "Les parties conviennent." }],
    text: "Les parties conviennent.",
    pdfFileId: null,
    pages: null,
    pagesSha256: null,
    sha256: shaNow,
    wordsKey: null,
    wordsParams: {},
    copyStates: {},
  }
}

/** A fresh client address per test, so no budget of one test reaches another. */
function nextIp(): string {
  ipSeq += 1
  return `203.0.113.${ipSeq % 250}`
}

function call(route: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`${BASE}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "door-browser", ...headers },
    body: JSON.stringify(body),
  })
}

async function waitForMail(pred: (m: EmailMessage) => boolean): Promise<EmailMessage> {
  for (let i = 0; i < 100; i++) {
    const m = capture.sent.find(pred)
    if (m) return m
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("no such mail")
}

function tokenOf(m: EmailMessage): string {
  const t = (m.text ?? m.html).match(/#t=([A-Za-z0-9_%-]+)/)?.[1]
  if (!t) throw new Error("no link in the mail")
  return decodeURIComponent(t)
}

function codeOf(m: EmailMessage): string {
  const c = (m.text ?? "").match(/\b(\d{6})\b/)?.[1]
  if (!c) throw new Error("no code in the mail")
  return c
}

async function mint(email = w.clientA.email, contactId = w.clientA.contactId) {
  const before = capture.sent.length
  const r = await mintClientAction({
    orgId: w.orgId,
    kind: "sign",
    targetApp: TARGET_APP,
    targetType: TARGET_TYPE,
    targetId: crypto.randomUUID(),
    contactId,
    companyId: w.companyA,
    invitedEmail: email,
    expiresInDays: 7,
    createdByUserId: w.admin.userId,
  })
  const mail = await waitForMail(
    (m) =>
      capture.sent.indexOf(m) >= before && m.template === "client-action.link" && m.to === email,
  )
  return { id: r.id, token: tokenOf(mail), mail }
}

/** Open, show the document, send a code and read it from the mail. */
async function upToCode(token: string, ip: string, email = w.clientA.email) {
  await call("open", { t: token }, { "x-bun-socket-ip": ip })
  await call("document", { t: token, format: "blocks" }, { "x-bun-socket-ip": ip })
  await clearRedisPatterns(["ca:code:gap:*"])
  const before = capture.sent.length
  const sent = await call("code", { t: token }, { "x-bun-socket-ip": ip })
  expect(sent.status).toBe(202)
  const mail = await waitForMail(
    (m) =>
      capture.sent.indexOf(m) >= before && m.template === "client-action.code" && m.to === email,
  )
  return codeOf(mail)
}

async function proofFor(token: string, ip: string, name = w.clientA.name): Promise<string> {
  const code = await upToCode(token, ip)
  const v = await call("verify", { t: token, code, name }, { "x-bun-socket-ip": ip })
  expect(v.status).toBe(200)
  return ((await v.json()) as { proof: string }).proof
}

async function row(id: string) {
  const [r] = await sql`SELECT * FROM ${k("client_actions")} WHERE id = ${id}`
  return r as Record<string, unknown>
}

beforeAll(async () => {
  await acquireTestLock()
  prevForce = process.env.RATE_LIMIT_FORCE_ENABLED
  process.env.RATE_LIMIT_FORCE_ENABLED = "true"
  previous = getSystemEmailProvider()
  setSystemEmailProvider(capture)
  w = await createDoorWorld()
  await awaitOrgApps(w.orgId)
  ClientActionTargetsTestAccess.set(TARGET_APP, TARGET_TYPE, ["sign", "accept"], async () => {
    if (viewDelayMs > 0) await new Promise((r) => setTimeout(r, viewDelayMs))
    return view()
  })
})

afterEach(async () => {
  viewDelayMs = 0
  shaNow = "b".repeat(64)
  await clearRedisPatterns(["ca:*"])
})

afterAll(async () => {
  ClientActionTargetsTestAccess.clear(TARGET_APP, TARGET_TYPE)
  setSystemEmailProvider(previous)
  if (prevForce === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
  else process.env.RATE_LIMIT_FORCE_ENABLED = prevForce
  await dropDoorWorld(w)
  await releaseTestLock()
})

describe("portal doors: the client action page", () => {
  it("NT-01: the stored hash used as a token opens nothing", async () => {
    const { id, token } = await mint()
    const r = await row(id)
    expect(r.token_hash).toBe(hashToken(token))
    const res = await call("open", { t: r.token_hash }, { "x-bun-socket-ip": nextIp() })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: "not_found" } })
  })

  it("NT-02: the twenty-first unknown token from one address gets 429", async () => {
    const ip = nextIp()
    const statuses: number[] = []
    for (let i = 0; i < 21; i++) {
      const t = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
      statuses.push((await call("open", { t }, { "x-bun-socket-ip": ip })).status)
    }
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true)
    expect(statuses[20]).toBe(429)
  })

  it("NT-03: a miss one character from a real token and a far miss answer byte for byte the same", async () => {
    const { token } = await mint()
    const last = token.slice(-1) === "A" ? "B" : "A"
    const near = `${token.slice(0, -1)}${last}`
    const far = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
    const a = await call("open", { t: near }, { "x-bun-socket-ip": nextIp() })
    const b = await call("open", { t: far }, { "x-bun-socket-ip": nextIp() })
    expect(a.status).toBe(b.status)
    expect(await a.text()).toBe(await b.text())
    expect(a.headers.get("content-type")).toBe(b.headers.get("content-type"))
  })

  it("NT-04: decide without a proof gets 401 and changes nothing", async () => {
    const { id, token } = await mint()
    const ip = nextIp()
    await upToCode(token, ip)
    const res = await call(
      "decide",
      { t: token, decision: "sign", typed_name: w.clientA.name },
      { "x-bun-socket-ip": ip },
    )
    expect(res.status).toBe(401)
    const r = await row(id)
    expect(r.decided_at).toBeNull()
    expect(r.decision).toBeNull()
  })

  it("NT-05: codes go only to the invited address, and the holder reads only this document", async () => {
    const { token } = await mint()
    const ip = nextIp()
    const before = capture.sent.length
    await upToCode(token, ip)
    // A typed address in the body changes nothing about where the code goes.
    await clearRedisPatterns(["ca:code:gap:*"])
    await call(
      "code",
      { t: token, email: "someone@elsewhere.example.com" },
      { "x-bun-socket-ip": ip },
    )
    await new Promise((r) => setTimeout(r, 50))
    const codes = capture.sent.slice(before).filter((m) => m.template === "client-action.code")
    expect(codes.length).toBeGreaterThan(0)
    expect(codes.every((m) => m.to === w.clientA.email)).toBe(true)
    const doc = (await (
      await call("document", { t: token, format: "text" }, { "x-bun-socket-ip": ip })
    ).json()) as Record<string, unknown>
    expect(Object.keys(doc).sort()).toEqual(["content", "format"])
  })

  it("NT-06: a real token's open sets no cookie, and the token gets 401 on every portal route", async () => {
    const { token } = await mint()
    const res = await call("open", { t: token }, { "x-bun-socket-ip": nextIp() })
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBeNull()
    for (const r of PORTAL_ROUTES) {
      if (r.path.startsWith(`${PORTAL_PREFIX}/auth/`)) continue
      const path = r.path.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000001")
      const init: RequestInit = { method: r.method, headers: { Authorization: `Bearer ${token}` } }
      if (r.method !== "GET") {
        init.body = "{}"
        ;(init.headers as Record<string, string>)["Content-Type"] = "application/json"
      }
      const got = await app.request(path, init)
      expect({ route: r.path, status: got.status }).toEqual({ route: r.path, status: 401 })
    }
  })

  it("NT-07: a scripted open without the person's gesture leaves the link unopened and sends no code", async () => {
    const { id, token } = await mint()
    const before = capture.sent.length
    const res = await call("open", { t: token }, { "x-bun-socket-ip": nextIp() })
    expect(res.status).toBe(200)
    expect((await row(id)).first_opened_at).toBeNull()
    await new Promise((r) => setTimeout(r, 50))
    expect(capture.sent.slice(before).filter((m) => m.template === "client-action.code")).toEqual(
      [],
    )
    await call("seen", { t: token }, { "x-bun-socket-ip": nextIp() })
    expect((await row(id)).first_opened_at).not.toBeNull()
  })

  it("NT-12: the privileged allowlist gains exactly the client action files, and a foreign org id in the body is ignored", async () => {
    const dir = join(import.meta.dir, "../../db-import-allowlist")
    const listed = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<
          string,
          Record<string, string>
        >
        return Object.values(j).flatMap((section) => Object.keys(section))
      })
      .filter((p) => p.startsWith("modules/client-actions/"))
      .sort()
    expect(listed).toEqual([
      "modules/client-actions/decide.ts",
      "modules/client-actions/document-files.ts",
      "modules/client-actions/mint.ts",
      "modules/client-actions/public-routes.ts",
      "modules/client-actions/routes.ts",
      "modules/client-actions/targets.ts",
    ])
    const { id, token } = await mint()
    const ip = nextIp()
    const proof = await proofFor(token, ip)
    const res = await call(
      "decide",
      {
        t: token,
        proof,
        decision: "sign",
        typed_name: w.clientA.name,
        org_id: w.otherOrgId,
        id: crypto.randomUUID(),
      },
      { "x-bun-socket-ip": ip },
    )
    expect(res.status).toBe(200)
    const r = await row(id)
    expect(r.org_id).toBe(w.orgId)
    expect(r.decision).toBe("signed")
  })

  it("NT-14: after a full flow no log line, Redis key or value holds the token or the code", async () => {
    const lines: string[] = []
    const origOut = process.stdout.write.bind(process.stdout)
    const origErr = process.stderr.write.bind(process.stderr)
    const grab = (chunk: unknown) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString())
      return true
    }
    process.stdout.write = grab as typeof process.stdout.write
    process.stderr.write = grab as typeof process.stderr.write
    let token = ""
    let code = ""
    try {
      const m = await mint()
      token = m.token
      const ip = nextIp()
      code = await upToCode(token, ip)
      const v = await call(
        "verify",
        { t: token, code, name: w.clientA.name },
        { "x-bun-socket-ip": ip },
      )
      const { proof } = (await v.json()) as { proof: string }
      await call(
        "decide",
        { t: token, proof, decision: "sign", typed_name: w.clientA.name },
        { "x-bun-socket-ip": ip },
      )
    } finally {
      process.stdout.write = origOut
      process.stderr.write = origErr
    }
    const logged = lines.join("")
    expect(logged.includes(token)).toBe(false)
    expect(logged.includes(code)).toBe(false)
    const keys = await redis.keys("*")
    expect(keys.filter((key) => key.includes(token) || key.includes(code))).toEqual([])
    // Every key's value, the job queues' hashes and lists included (a queued mail job
    // would hold its rendered body there).
    const prefix = redis.options.keyPrefix ?? ""
    // The code mail is sent directly, never queued, so whether job-queue keys exist depends on
    // what ran before; the scan below reads every key there is, queues included when present.
    expect(keys.length).toBeGreaterThan(0)
    for (const raw of keys) {
      const key = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
      const type = await redis.type(key)
      const value =
        type === "string"
          ? ((await redis.get(key)) ?? "")
          : type === "hash"
            ? JSON.stringify(await redis.hgetall(key))
            : type === "list"
              ? JSON.stringify(await redis.lrange(key, 0, 500))
              : type === "zset"
                ? JSON.stringify(await redis.zrange(key, "0", "500"))
                : type === "stream"
                  ? JSON.stringify(await redis.xrange(key, "-", "+", "COUNT", "500"))
                  : ""
      expect({ key, holds: value.includes(token) || value.includes(code) }).toEqual({
        key,
        holds: false,
      })
    }
    // The outbox and the job queues hold no rendered mail and no token either.
    const [outbox] = await sql`
      SELECT count(*)::int AS n FROM ${k("pending_events")}
       WHERE payload::text LIKE ${`%${token}%`} OR payload::text LIKE ${`%${code}%`}`
    expect((outbox as { n: number }).n).toBe(0)
  })

  it("NT-15: ten parallel decides with one proof give one success and nine conflicts; the proof is spent", async () => {
    const { id, token } = await mint()
    const ip = nextIp()
    const proof = await proofFor(token, ip)
    const answers = await Promise.all(
      Array.from({ length: 10 }, () =>
        call(
          "decide",
          { t: token, proof, decision: "sign", typed_name: w.clientA.name },
          { "x-bun-socket-ip": ip },
        ),
      ),
    )
    const statuses = answers.map((a) => a.status).sort()
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect(statuses.filter((s) => s === 409)).toHaveLength(9)
    const [events] = await sql`
      SELECT count(*)::int AS n FROM ${k("client_action_events")} WHERE action_id = ${id} AND event = 'decided'`
    expect((events as { n: number }).n).toBe(1)
  })

  it("NT-16: past its expiry by the database's clock, a decide with a valid proof gets 409 expired", async () => {
    const { id, token } = await mint()
    const ip = nextIp()
    const proof = await proofFor(token, ip)
    await sql`UPDATE ${k("client_actions")} SET expires_at = now() - interval '1 second' WHERE id = ${id}`
    const res = await call(
      "decide",
      { t: token, proof, decision: "sign", typed_name: w.clientA.name },
      { "x-bun-socket-ip": ip },
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { state: string }).state).toBe("expired")
    expect((await row(id)).decided_at).toBeNull()
  })

  it("NT-17: a withdrawal, a replaced version or ended access between verify and decide refuses", async () => {
    for (const close of ["withdrawn", "version", "ended"] as const) {
      const { id, token } = await mint()
      const ip = nextIp()
      const proof = await proofFor(token, ip)
      if (close === "withdrawn") {
        await revokeClientAction({
          orgId: w.orgId,
          id,
          reason: "withdrawn",
          byUserId: w.admin.userId,
        })
      } else if (close === "version") {
        shaNow = "c".repeat(64)
      } else {
        await sql`UPDATE ${k("companies")} SET portal_ended_at = now() WHERE id = ${w.companyA}`
      }
      const res = await call(
        "decide",
        { t: token, proof, decision: "sign", typed_name: w.clientA.name },
        { "x-bun-socket-ip": ip },
      )
      expect({ close, status: res.status }).toEqual({ close, status: 409 })
      expect((await row(id)).decided_at).toBeNull()
      shaNow = "b".repeat(64)
      await sql`UPDATE ${k("companies")} SET portal_ended_at = NULL WHERE id = ${w.companyA}`
    }
  })

  it("NT-18: five wrong per code pause, twenty in total lock, and neither a new code nor a new address resets the total", async () => {
    const wrong = (c: string) => (c === "000000" ? "111111" : "000000")
    // 4 wrong then the right code passes.
    {
      const { token } = await mint()
      const ip = nextIp()
      const code = await upToCode(token, ip)
      for (let i = 0; i < 4; i++) {
        const r = await call(
          "verify",
          { t: token, code: wrong(code), name: "N" },
          { "x-bun-socket-ip": ip },
        )
        expect(r.status).toBe(401)
      }
      const ok = await call("verify", { t: token, code, name: "N" }, { "x-bun-socket-ip": ip })
      expect(ok.status).toBe(200)
    }
    // 5 wrong pause; the right code during the pause fails.
    {
      const { id, token } = await mint()
      const ip = nextIp()
      const code = await upToCode(token, ip)
      const answers: number[] = []
      for (let i = 0; i < 5; i++) {
        answers.push(
          (
            await call(
              "verify",
              { t: token, code: wrong(code), name: "N" },
              { "x-bun-socket-ip": ip },
            )
          ).status,
        )
      }
      expect(answers).toEqual([401, 401, 401, 401, 423])
      const during = await call("verify", { t: token, code, name: "N" }, { "x-bun-socket-ip": ip })
      expect(during.status).toBe(423)
      // 19 wrong in total leaves it open; the 20th locks; a new code and a new address do not reset.
      let total = 5
      while (total < 19) {
        // Later that day: past the pause, with send budget again.
        await redis.del(`ca:code:pause:${id}`, `ca:code:hour:${id}`, `ca:code:day:${id}`)
        const c2 = await upToCode(token, nextIp())
        for (let i = 0; i < 4 && total < 19; i++, total++) {
          await call(
            "verify",
            { t: token, code: wrong(c2), name: "N" },
            { "x-bun-socket-ip": nextIp() },
          )
        }
      }
      const at19 = await row(id)
      expect(at19.code_wrong_total).toBe(19)
      expect(at19.code_locked_at).toBeNull()
      await redis.del(`ca:code:pause:${id}`, `ca:code:hour:${id}`, `ca:code:day:${id}`)
      const c3 = await upToCode(token, nextIp())
      const locked = await call(
        "verify",
        { t: token, code: wrong(c3), name: "N" },
        { "x-bun-socket-ip": nextIp() },
      )
      expect(locked.status).toBe(410)
      expect(((await locked.json()) as { state: string }).state).toBe("attempts")
      expect((await row(id)).code_locked_at).not.toBeNull()
    }
  })

  it("NT-19: with a minute between sends, five codes an hour go out and the sixth gets 429 with no mail", async () => {
    const { id, token } = await mint()
    const ip = nextIp()
    await call("document", { t: token, format: "blocks" }, { "x-bun-socket-ip": ip })
    const before = capture.sent.length
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      await redis.del(`ca:code:gap:${id}`) // a minute and a second later
      statuses.push((await call("code", { t: token }, { "x-bun-socket-ip": ip })).status)
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429])
    // Inside the minute the next send is refused too.
    const soon = await call("code", { t: token }, { "x-bun-socket-ip": ip })
    expect(soon.status).toBe(429)
    expect(
      capture.sent.slice(before).filter((m) => m.template === "client-action.code"),
    ).toHaveLength(5)
  })

  it("NT-21: a typed address is never mailed; a copy goes only to the invited address", async () => {
    const { token } = await mint()
    const ip = nextIp()
    const before = capture.sent.length
    const typed = "intruder@elsewhere.example.com"
    for (const type of ["invite_asked", "not_me", "new_link", "question"]) {
      const res = await call(
        "request",
        { t: token, type, email: typed, text: "hello" },
        { "x-bun-socket-ip": ip },
      )
      expect(res.status).toBe(202)
    }
    const proof = await proofFor(token, ip)
    await call(
      "decide",
      { t: token, proof, decision: "sign", typed_name: w.clientA.name },
      { "x-bun-socket-ip": ip },
    )
    for (let i = 0; i < 4; i++) {
      await call("request", { t: token, type: "copy", email: typed }, { "x-bun-socket-ip": ip })
    }
    await new Promise((r) => setTimeout(r, 100))
    const sent = capture.sent.slice(before)
    expect(sent.filter((m) => m.to === typed)).toEqual([])
    const copies = sent.filter((m) => m.template === "client-action.copy")
    expect(copies).toHaveLength(3)
    expect(copies.every((m) => m.to === w.clientA.email)).toBe(true)
  })

  it("NT-43: a client decision touches no approval request, and the approvals module never reads client actions", async () => {
    const dir = join(import.meta.dir, "../../../modules/approvals")
    const files = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    const readers = files.filter((f) =>
      /client_actions|clientActions|client-actions/.test(readFileSync(join(dir, f), "utf8")),
    )
    expect(readers).toEqual([])
    const [before] =
      await sql`SELECT count(*)::int AS n, string_agg(id::text || status, ',' ORDER BY id) AS at FROM ${k("approval_requests")} WHERE org_id = ${w.orgId}`
    const { token } = await mint()
    const ip = nextIp()
    const proof = await proofFor(token, ip)
    expect(
      (
        await call(
          "decide",
          { t: token, proof, decision: "sign", typed_name: w.clientA.name },
          { "x-bun-socket-ip": ip },
        )
      ).status,
    ).toBe(200)
    const [after] =
      await sql`SELECT count(*)::int AS n, string_agg(id::text || status, ',' ORDER BY id) AS at FROM ${k("approval_requests")} WHERE org_id = ${w.orgId}`
    expect(after).toEqual(before)
  })

  it("NT-44: no tool signs, decides or accepts a client action, and a member or MCP bearer is no proof", async () => {
    const names = [...toolRegistry.entriesOf(w.orgId)].map(([[, a, n]]) => `${a}:${n}`)
    expect(
      names.filter((n) => /client_action/.test(n) && /sign|decide|accept|approve/.test(n)),
    ).toEqual([])
    // An app's tool on this list is only the `viewTool` its manifest names for a
    // client action target: the kernel's page loads with it what the person
    // outside is shown. It is read only and hidden from agents, and decides nothing.
    const bundled = join(import.meta.dir, "../../../../../../bundled-apps")
    const viewTools = new Set<string>()
    for (const appName of readdirSync(bundled)) {
      let manifest: {
        clientActionTargets?: Array<{ viewTool?: string }>
        tools?: Record<string, { readOnly?: boolean; agentVisible?: boolean }>
      }
      try {
        manifest = JSON.parse(readFileSync(join(bundled, appName, "app.manifest.json"), "utf8"))
      } catch {
        continue
      }
      for (const target of manifest.clientActionTargets ?? []) {
        const tool = target.viewTool ? manifest.tools?.[target.viewTool] : undefined
        expect({ appName, viewTool: target.viewTool, tool }).toMatchObject({
          tool: { readOnly: true, agentVisible: false },
        })
        viewTools.add(`${appName}:${target.viewTool}`)
      }
    }
    const touching = names.filter((n) => /client_action/.test(n))
    expect(touching.filter((n) => !viewTools.has(n)).sort()).toEqual([
      "kernel:client_action_create",
      "kernel:client_action_revoke",
      "kernel:client_actions_list",
    ])
    const { id, token } = await mint()
    const ip = nextIp()
    await upToCode(token, ip)
    const member = (await createSession(w.admin.userId, w.orgId)).accessToken
    const res = await call(
      "decide",
      { t: token, decision: "sign", typed_name: w.clientA.name },
      { "x-bun-socket-ip": ip, Authorization: `Bearer ${member}` },
    )
    expect(res.status).toBe(401)
    expect((await row(id)).decided_at).toBeNull()
  })

  it("NT-56: a decline without the code is kept, marked code not verified, and the sender is told", async () => {
    const { id, token } = await mint()
    const ip = nextIp()
    const res = await call(
      "decide",
      { t: token, decision: "decline", reason: "Pas pour nous" },
      { "x-bun-socket-ip": ip },
    )
    expect(res.status).toBe(200)
    expect((await row(id)).decision).toBe("declined")
    const [ev] = await sql`
      SELECT meta FROM ${k("client_action_events")} WHERE action_id = ${id} AND event = 'declined'`
    expect((ev as { meta: { code_verified: boolean } }).meta.code_verified).toBe(false)
    const [queued] = await sql`
      SELECT count(*)::int AS n FROM ${k("pending_events")}
       WHERE payload->>'entityId' = ${id} AND payload->>'entity' = 'client_action'
         AND payload->>'action' = 'decided'`
    expect((queued as { n: number }).n).toBeGreaterThan(0)
  })

  it("NT-59: a name or capacity with a control character or over 200 characters is refused, and no subject holds client text", async () => {
    const { token } = await mint()
    const ip = nextIp()
    const code = await upToCode(token, ip)
    for (const body of [
      { name: "Paul\r\nBcc: x@y.example.com" },
      { name: "x".repeat(201) },
      { name: "Paul", capacity: "Gérant\u0000" },
    ]) {
      const res = await call("verify", { t: token, code, ...body }, { "x-bun-socket-ip": ip })
      expect(res.status).toBe(400)
    }
    const subjects = capture.sent.map((m) => m.subject)
    expect(subjects.some((s) => s.includes("Bcc") || /[\r\n]/.test(s))).toBe(false)
  })

  it("NT-60: a spoofed forwarded address from an untrusted hop is not stored", async () => {
    const { id, token } = await mint()
    const ip = nextIp()
    await call(
      "decide",
      { t: token, decision: "decline" },
      { "x-bun-socket-ip": ip, "X-Forwarded-For": "198.51.100.77" },
    )
    const devices = await sql`
      SELECT d.ip FROM ${k("client_action_devices")} d
        JOIN ${k("client_action_events")} e ON e.id = d.event_id WHERE e.action_id = ${id}`
    expect(devices.map((d) => (d as { ip: string }).ip)).not.toContain("198.51.100.77")
  })

  it("NT-49: the public client action routes answer with no referrer, no index, no store and no framing", async () => {
    const res = await call("open", { t: "x".repeat(43) }, { "x-bun-socket-ip": nextIp() })
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
    expect(res.headers.get("x-robots-tag")).toContain("noindex")
    expect(res.headers.get("cache-control")).toContain("no-store")
    expect(res.headers.get("content-security-policy") ?? "").toContain("frame-ancestors 'none'")
  })

  it("NT-66: a typed phrase with a control character is refused, and one that differs from the required phrase does not sign", async () => {
    const { id, token } = await mint()
    await sql`UPDATE ${k("client_actions")} SET required_phrase = 'Bon pour accord' WHERE id = ${id}`
    const ip = nextIp()
    const proof = await proofFor(token, ip)
    const bad = await call(
      "decide",
      {
        t: token,
        proof,
        decision: "sign",
        typed_name: w.clientA.name,
        typed_phrase: "Bon\u0007pour accord",
      },
      { "x-bun-socket-ip": ip },
    )
    expect(bad.status).toBe(400)
    const other = await call(
      "decide",
      {
        t: token,
        proof,
        decision: "sign",
        typed_name: w.clientA.name,
        typed_phrase: "Bon pour rien",
      },
      { "x-bun-socket-ip": ip },
    )
    expect(other.status).toBe(422)
    expect((await row(id)).decided_at).toBeNull()
  })
})

// Kept beside the doors: a portal session is no holder of a link either.
describe("portal doors: a portal session on the link routes", () => {
  it("a portal token in the header does not stand for a staff signer's session", async () => {
    const portal = (await createPortalSession(w.clientA.userId, w.orgId)).accessToken
    const { token } = await mint()
    const res = await call(
      "open",
      { t: token },
      { "x-bun-socket-ip": nextIp(), Authorization: `Bearer ${portal}` },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBeNull()
  })
})
