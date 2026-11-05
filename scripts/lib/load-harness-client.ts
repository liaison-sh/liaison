// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The load harness's client side (apps/api/src/lib/load-harness.ts): signed
// requests with the box's LOAD_HARNESS_KEY, and the seeding of load orgs
// through the signed demo start, verified with the code the signed sink read
// returns. Generic: the box URL and the key come from the caller.
import { createHash, createHmac, randomBytes } from "node:crypto"
import type { FanoutReport } from "../../apps/api/src/infra/jobs/fanout-report"

export const HARNESS_HEADERS = {
  timestamp: "x-liaison-harness-timestamp",
  nonce: "x-liaison-harness-nonce",
  signature: "x-liaison-harness-signature",
} as const

/** HMAC-SHA256(key, METHOD \n path \n ts \n nonce \n sha256hex(body)), hex. */
export function harnessSignature(
  key: string,
  f: { method: string; path: string; timestamp: number; nonce: string; body: string },
): string {
  const bodyHash = createHash("sha256").update(f.body).digest("hex")
  return createHmac("sha256", key)
    .update([f.method.toUpperCase(), f.path, String(f.timestamp), f.nonce, bodyHash].join("\n"))
    .digest("hex")
}

/** The three harness headers for one request. */
export function harnessHeaders(
  key: string,
  method: string,
  path: string,
  body = "",
  now = Date.now(),
): Record<string, string> {
  const nonce = `c${randomBytes(16).toString("hex")}`
  return {
    [HARNESS_HEADERS.timestamp]: String(now),
    [HARNESS_HEADERS.nonce]: nonce,
    [HARNESS_HEADERS.signature]: harnessSignature(key, {
      method,
      path,
      timestamp: now,
      nonce,
      body,
    }),
  }
}

export interface LoadSession {
  accessToken: string
  /** `name=value` of the refresh cookie, or null when the box sent none. */
  refreshCookie: string | null
  issuedAt: number
}

export interface LoadOrg {
  index: number
  orgId: string
  userId: string
  /** The start took a warm-pool workspace (it answered `ready` at once). */
  pooled: boolean
  verified: boolean
  sessions: LoadSession[]
}

export interface SinkEntry {
  kind: string
  key: string
  count: number
  firstAt: number
  lastAt: number
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** The refresh cookie among a response's Set-Cookie headers (`name=value`). */
export function refreshCookieFrom(setCookies: string[]): string | null {
  for (const raw of setCookies) {
    const pair = raw.split(";")[0] ?? ""
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name.includes("liaison_rt") && value) return `${name}=${value}`
  }
  return null
}

export class HarnessClient {
  constructor(
    readonly box: string,
    private readonly key: string,
    private readonly fetchImpl: FetchLike = fetch,
    /** A request that takes longer is abandoned (a hung box never hangs the driver). */
    private readonly timeoutMs: number = 30_000,
  ) {
    if (key.length < 32) throw new Error("LOAD_HARNESS_KEY must be at least 32 characters")
    this.box = box.replace(/\/$/, "")
  }

  async signed(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const raw = body === undefined ? "" : JSON.stringify(body)
    return this.fetchImpl(`${this.box}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...harnessHeaders(this.key, method, path, raw),
        ...headers,
      },
      ...(body === undefined ? {} : { body: raw }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
  }

  /** A signed demo start (`@load.invalid`). The same signupKey again returns the same workspace with a new session. */
  async start(input: { name: string; email: string; needs: string[]; signupKey: string }) {
    const res = await this.signed("POST", "/api/demo/orgs", { ...input, turnstileToken: "-" })
    const text = await res.text()
    if (res.status !== 201) throw new Error(`demo start ${res.status}: ${text.slice(0, 300)}`)
    const data = (
      JSON.parse(text) as {
        data: { orgId: string; userId: string; state: string; accessToken: string }
      }
    ).data
    return {
      ...data,
      session: {
        accessToken: data.accessToken,
        refreshCookie: refreshCookieFrom(res.headers.getSetCookie()),
        issuedAt: Date.now(),
      } satisfies LoadSession,
    }
  }

  /** The signed sink read of a load org: its sunk code and effect counts. */
  async sink(orgId: string): Promise<{ demoCode: string | null; effects: SinkEntry[] }> {
    const res = await this.signed("GET", `/api/demo/harness/orgs/${orgId}/sink`)
    if (res.status !== 200) throw new Error(`sink read of ${orgId}: ${res.status}`)
    return ((await res.json()) as { data: { demoCode: string | null; effects: SinkEntry[] } }).data
  }

  /** A signed flood: `count` synthetic jobs (at most 20 000, each `sleepMs` at most 2 000) for one load org. */
  async flood(
    orgId: string,
    count: number,
    sleepMs: number,
  ): Promise<{ enqueued: number; queue: string }> {
    const res = await this.signed("POST", "/api/demo/harness/flood", { orgId, count, sleepMs })
    const text = await res.text()
    if (res.status !== 200)
      throw new Error(`flood of ${orgId}: ${res.status} ${text.slice(0, 300)}`)
    return (JSON.parse(text) as { data: { enqueued: number; queue: string } }).data
  }

  /** The signed fan-out report (scripts/lib/fanout-counters.ts judges it). */
  async fanoutReport(input: {
    orgIds: string[]
    fromMs: number
    toMs: number
    floodOrgId?: string
    queues?: string[]
  }): Promise<FanoutReport> {
    const res = await this.signed("POST", "/api/demo/harness/fanout-report", input)
    const text = await res.text()
    if (res.status !== 200) throw new Error(`fan-out report: ${res.status} ${text.slice(0, 300)}`)
    return (JSON.parse(text) as { data: FanoutReport }).data
  }

  /** The workspace's fill state (`provisioning`, `ready`, `partial`, ...). */
  async status(orgId: string): Promise<string> {
    const res = await this.signed("GET", `/api/demo/orgs/${orgId}/status`)
    if (res.status !== 200) throw new Error(`status of ${orgId}: ${res.status}`)
    return ((await res.json()) as { data: { state: string } }).data.state
  }

  /** Wait until a fresh (non-pooled) workspace is filled; its seed changes the visitor's permissions. */
  async waitReady(orgId: string, timeoutMs = 600_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const state = await this.status(orgId)
      if (state !== "provisioning") return state
      if (Date.now() > deadline)
        throw new Error(`workspace ${orgId} still provisioning after ${timeoutMs} ms`)
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  async verify(session: LoadSession, code: string): Promise<boolean> {
    const res = await this.signed(
      "POST",
      "/api/demo/verify",
      { code },
      { authorization: `Bearer ${session.accessToken}` },
    )
    return res.status === 200
  }
}

/** A stable signup key per (seed, prefix, index): a re-run inside its hour finds the same workspace. */
export function seedSignupKey(seed: string, prefix: string, index: number): string {
  return `${prefix}${createHash("sha256").update(`${seed}\n${prefix}\n${index}`).digest("hex").slice(0, 40)}`
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .padEnd(32, "0")
    .slice(0, 128)
}

/**
 * Seed `orgs` load orgs: each a signed demo start (a warm-pool workspace when
 * the pool has one, flagged a load org), `sessions` sessions (one per VU that
 * acts in it), verified with its sunk code. Deterministic per `seed`: a re-run
 * with the same seed inside the box's signup-key hour returns the same orgs.
 */
export async function seedLoadOrgs(
  client: HarnessClient,
  opts: {
    orgs: number
    prefix: string
    seed: string
    sessions: number
    needs: string[]
    log?: (line: string) => void
  },
): Promise<LoadOrg[]> {
  const out: LoadOrg[] = []
  for (let index = 0; index < opts.orgs; index++) {
    const signupKey = seedSignupKey(opts.seed, opts.prefix, index)
    const input = {
      name: `${opts.prefix}${index}`,
      email: `${signupKey.toLowerCase()}@load.invalid`,
      needs: opts.needs,
      signupKey,
    }
    const first = await client.start(input)
    // A workspace the pool did not have is filled behind the response, and its
    // seed changes the visitor's permissions: its sessions are made once it is
    // filled (a resume with the same signup key gives a new session).
    const filled =
      first.state === "provisioning" ? await client.waitReady(first.orgId) : first.state
    const sessions = filled === first.state ? [first.session] : []
    while (sessions.length < opts.sessions) sessions.push((await client.start(input)).session)
    const { demoCode } = await client.sink(first.orgId)
    // A re-run finds the workspace already verified: no code is on record then.
    const verified = demoCode ? await client.verify(sessions[0]!, demoCode) : true
    if (!verified) throw new Error(`load org ${first.orgId}: its sunk code did not verify`)
    out.push({
      index,
      orgId: first.orgId,
      userId: first.userId,
      pooled: first.state === "ready",
      verified,
      sessions,
    })
    opts.log?.(`load orgs: org ${index + 1}/${opts.orgs} ${first.orgId} (${first.state})`)
  }
  return out
}
