// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client action tests' shared world: the door fixture's org, its people and
// companies, a captured system mail channel, a test target whose read tool
// answers what the test sets, and the page's calls through the real app.
import { afterAll, afterEach, beforeAll, expect } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import type { EmailMessage, EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { awaitOrgApps } from "~/modules/apps/init"
import { type MintInput, mintClientAction } from "~/modules/client-actions/mint"
import {
  ClientActionTargetsTestAccess,
  type ClientActionView,
} from "~/modules/client-actions/targets"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"
import {
  CaptureProvider,
  createDoorWorld,
  type DoorPerson,
  type DoorWorld,
  dropDoorWorld,
} from "~/tests/security/portal-doors/fixture"

export const BASE = "/api/public/client-actions"
export const k = (table: string) => sql(`${schemaRef("kernel")}.${table}`)

export interface Kit {
  w: DoorWorld
  capture: CaptureProvider
  /** What the target's read tool returns next; tests change it. */
  view: ClientActionView
  /** Milliseconds the read tool waits before answering. */
  viewDelayMs: number
  /** False: the read tool answers nothing, as an app that cannot read the target. */
  viewAnswers: boolean
  targetApp: string
  targetType: string
}

export function baseView(): ClientActionView {
  return {
    title: "Contrat Maison Alpha",
    senderName: "Admin",
    summary: [{ k: "Montant", v: "1 200 EUR" }],
    sourceBlocks: [{ type: "paragraph", text: "Les parties conviennent." }],
    text: "Les parties conviennent.",
    pdfFileId: null,
    pages: null,
    pagesSha256: null,
    sha256: "b".repeat(64),
    wordsKey: null,
    wordsParams: {},
  }
}

/** Registers the world for the file: one org, a capturing mail channel, the test target. */
export function useClientActionWorld(targetApp: string, targetType = "contract"): Kit {
  const kit = {
    capture: new CaptureProvider(),
    view: baseView(),
    viewDelayMs: 0,
    viewAnswers: true,
    targetApp,
    targetType,
  } as Kit
  let previous: EmailProvider
  let prevForce: string | undefined
  beforeAll(async () => {
    await acquireTestLock()
    prevForce = process.env.RATE_LIMIT_FORCE_ENABLED
    process.env.RATE_LIMIT_FORCE_ENABLED = "true"
    previous = getSystemEmailProvider()
    setSystemEmailProvider(kit.capture)
    kit.w = await createDoorWorld()
    await awaitOrgApps(kit.w.orgId)
    ClientActionTargetsTestAccess.set(targetApp, targetType, ["sign", "accept"], async () => {
      if (kit.viewDelayMs > 0) await new Promise((r) => setTimeout(r, kit.viewDelayMs))
      return kit.viewAnswers ? kit.view : null
    })
  })
  afterEach(async () => {
    kit.viewDelayMs = 0
    kit.viewAnswers = true
    kit.view = baseView()
    await clearRedisPatterns(["ca:*"])
  })
  afterAll(async () => {
    ClientActionTargetsTestAccess.clear(targetApp, targetType)
    setSystemEmailProvider(previous)
    if (prevForce === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
    else process.env.RATE_LIMIT_FORCE_ENABLED = prevForce
    if (kit.w) {
      await sql`DELETE FROM ${k("attention_events")} WHERE org_id = ${kit.w.orgId}`
      await sql`DELETE FROM ${k("files")} WHERE org_id = ${kit.w.orgId}`
      await dropDoorWorld(kit.w)
    }
    await releaseTestLock()
  })
  return kit
}

let ipSeq = Math.floor(Math.random() * 200)
/** A fresh client address per call site, so no budget of one test reaches another. */
export function nextIp(): string {
  ipSeq += 1
  return `198.51.100.${(ipSeq % 250) + 1}`
}

export function call(route: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`${BASE}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "kit-browser", ...headers },
    body: JSON.stringify(body),
  })
}

export async function waitForMail(
  kit: Kit,
  pred: (m: EmailMessage) => boolean,
): Promise<EmailMessage> {
  for (let i = 0; i < 150; i++) {
    const m = kit.capture.sent.find(pred)
    if (m) return m
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("no such mail")
}

export function tokenOf(m: EmailMessage): string {
  const t = (m.text ?? m.html).match(/#t=([A-Za-z0-9_%-]+)/)?.[1]
  if (!t) throw new Error("no link in the mail")
  return decodeURIComponent(t)
}

export function codeOf(m: EmailMessage): string {
  const c = (m.text ?? "").match(/\b(\d{6})\b/)?.[1]
  if (!c) throw new Error("no code in the mail")
  return c
}

/** Mints a link to `who` and reads its token from the captured mail. */
export async function mintTo(
  kit: Kit,
  who: DoorPerson = kit.w.clientA,
  over: Partial<MintInput> = {},
) {
  const before = kit.capture.sent.length
  const r = await mintClientAction({
    orgId: kit.w.orgId,
    kind: "sign",
    targetApp: kit.targetApp,
    targetType: kit.targetType,
    targetId: crypto.randomUUID(),
    contactId: who.contactId,
    companyId: kit.w.companyA,
    invitedEmail: who.email,
    expiresInDays: 7,
    createdByUserId: kit.w.admin.userId,
    ...over,
  })
  const mail = await waitForMail(
    kit,
    (m) =>
      kit.capture.sent.indexOf(m) >= before &&
      m.template === "client-action.link" &&
      m.to === who.email,
  )
  return { id: r.id, token: tokenOf(mail), mail, result: r }
}

/** Opens, shows the document, sends a code and reads it from the mail. */
export async function codeFor(kit: Kit, token: string, ip: string, email: string) {
  await call("open", { t: token }, { "x-bun-socket-ip": ip })
  await call("document", { t: token, format: "blocks" }, { "x-bun-socket-ip": ip })
  await clearRedisPatterns(["ca:code:gap:*"])
  const before = kit.capture.sent.length
  const sent = await call("code", { t: token }, { "x-bun-socket-ip": ip })
  expect(sent.status).toBe(202)
  const mail = await waitForMail(
    kit,
    (m) =>
      kit.capture.sent.indexOf(m) >= before &&
      m.template === "client-action.code" &&
      m.to === email,
  )
  return codeOf(mail)
}

export async function proofFor(
  kit: Kit,
  token: string,
  ip: string,
  who: DoorPerson = kit.w.clientA,
  headers: Record<string, string> = {},
): Promise<string> {
  const code = await codeFor(kit, token, ip, who.email)
  const v = await call(
    "verify",
    { t: token, code, name: who.name },
    { "x-bun-socket-ip": ip, ...headers },
  )
  expect(v.status).toBe(200)
  return ((await v.json()) as { proof: string }).proof
}

export async function actionRow(id: string): Promise<Record<string, unknown>> {
  const [r] = await sql`SELECT * FROM ${k("client_actions")} WHERE id = ${id}`
  return r as Record<string, unknown>
}

export async function eventsOf(id: string): Promise<Array<{ event: string; meta: unknown }>> {
  return (await sql`
    SELECT event, meta FROM ${k("client_action_events")} WHERE action_id = ${id} ORDER BY at, id
  `) as unknown as Array<{ event: string; meta: unknown }>
}
