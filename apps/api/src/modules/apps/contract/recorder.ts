// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Recording egress fixtures for the app contract harness (harness.ts), the
// half a developer runs once against a provider's sandbox account; CI only
// replays what it wrote (replay-bridge.ts).
//
// `recordEntry` runs one entry point in a contract isolate (the same executor,
// virtual clock and seeded random a replay uses) on a REAL bridge wrapped by
// the recording bridge, so the fixture holds exactly the calls a replay of the
// same input makes. `scrubFixture` then replaces every secret and personal
// value with a stand-in, the same stand-in everywhere in the fixture (a
// replayed call matches its recorded arguments only if both were scrubbed
// alike), and `verifyFixture` replays the scrubbed fixture twice on the same
// isolate: a fixture is written only when its replay asks for no call it does
// not hold. The repository is public: read what a recorder writes before you
// commit it.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RunLimits } from "~/modules/apps/run-limits"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import type { ContractEntry } from "./entries"
import type { BridgeSurface } from "./harness"
import type { ContractIsolate, ContractRunOutcome } from "./isolate"
import {
  canonicalJson,
  createRecordingBridge,
  createReplayBridge,
  type EgressFixture,
} from "./replay-bridge"

export interface RecordInput {
  params?: unknown
  extraArgs?: unknown[]
}

export interface RecordedRun {
  fixture: EgressFixture
  outcome: ContractRunOutcome
}

/** Limits for a recording run: the provider's real latency, not the production budget. */
export function recordingLimits(base: RunLimits): RunLimits {
  return { ...base, wallMs: Math.max(base.wallMs, 120_000) }
}

/** Run `entry` once on `real` (a live bridge), recording every call and its answer. */
export async function recordEntry(args: {
  isolate: ContractIsolate
  entry: ContractEntry
  input: RecordInput
  real: AppBridge
  surface: BridgeSurface
  limits: RunLimits
  recordedFrom: string
}): Promise<RecordedRun> {
  const { entry, input } = args
  const rec = createRecordingBridge(
    args.real,
    {
      entry: entry.entry,
      ...(input.params !== undefined ? { params: input.params } : {}),
      ...(input.extraArgs ? { extraArgs: input.extraArgs } : {}),
      recordedFrom: args.recordedFrom,
    },
    args.surface,
  )
  const outcome = await args.isolate.run({
    exportName: entry.exportName,
    params: input.params ?? {},
    ...(input.extraArgs ? { extraArgs: input.extraArgs } : {}),
    bridge: rec.bridge,
    limits: recordingLimits(args.limits),
  })
  return { fixture: rec.finish(), outcome }
}

/** A literal to replace everywhere in a fixture, and its stand-in. */
export interface Replacement {
  from: string
  to: string
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** IPv4 addresses (a buyer's browser IP on an order). */
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

/**
 * Replace secrets and personal values everywhere in `fixture` (params, call
 * arguments, answers): the given literals first (a store domain, a token, the
 * recording org's ids), then every email address (case-insensitively mapped,
 * one stand-in per address), then IPv4 addresses. Phone numbers are replaced
 * only inside JSON string values that look like phone fields (`phone` keys), so
 * ids and amounts are never touched. Strings keep their meaning for the app: a
 * stand-in email is still an email.
 */
export function scrubFixture(fixture: EgressFixture, replacements: Replacement[]): EgressFixture {
  return scrubValue(trimFetchHeaders(fixture), replacements) as EgressFixture
}

/** `scrubFixture` for any JSON value (a webhook body scrubbed before it is signed). */
export function scrubValue(value: unknown, replacements: Replacement[]): unknown {
  let text = JSON.stringify(value)
  for (const r of replacements) {
    if (!r.from) continue
    text = text.split(r.from).join(r.to)
  }
  const emails = new Map<string, string>()
  text = text.replace(EMAIL_RE, (m) => {
    const key = m.toLowerCase()
    if (key.endsWith("@example.com") || key.endsWith("@example.org")) return m
    let stand = emails.get(key)
    if (!stand) {
      stand = `person${emails.size + 1}@example.com`
      emails.set(key, stand)
    }
    return stand
  })
  text = text.replace(IPV4_RE, (m) => (m.startsWith("127.") ? m : "192.0.2.1"))
  return scrubPhones(JSON.parse(text))
}

/** Response headers a fetch fixture keeps: the ones apps read. The rest (request ids, CDN, CSP) go. */
const KEPT_RESPONSE_HEADERS = new Set(["content-type", "retry-after", "link", "location"])

/** Drop a recorded `fetch` answer's response headers but the ones an app reads. */
function trimFetchHeaders(fixture: EgressFixture): EgressFixture {
  const trim = (reply: unknown): unknown => {
    const asText = typeof reply === "string"
    let v: unknown = reply
    if (asText) {
      try {
        v = JSON.parse(reply as string)
      } catch {
        return reply
      }
    }
    const r = v as { headers?: Record<string, string> } | null
    if (!r || typeof r !== "object" || !r.headers || typeof r.headers !== "object") return reply
    const headers = Object.fromEntries(
      Object.entries(r.headers).filter(([k]) => KEPT_RESPONSE_HEADERS.has(k.toLowerCase())),
    )
    const out = { ...r, headers }
    return asText ? JSON.stringify(out) : out
  }
  return {
    ...fixture,
    calls: fixture.calls.map((c) =>
      c.method === "fetch" && "reply" in c ? { ...c, reply: trim(c.reply) } : c,
    ),
  }
}

/** Keys whose value is a credential or an access token (an order's checkout or status-page token). */
const SECRET_KEY_RE = /(^|_)(token|secret|password|api_key|access_key)$/i
/** A credential in a URL's query (`?key=…`, `&token=…`). */
const SECRET_QUERY_RE = /([?&](?:key|token|access_token|signature)=)[^&"\\\s]+/gi

function scrubPhones(v: unknown, key = ""): unknown {
  if (typeof v === "string") {
    if (SECRET_KEY_RE.test(key) && v.length > 0) return "redacted"
    // A phone field's whole value goes (a partial match would keep a country code).
    if (/phone/i.test(key)) return (v.match(/\d/g)?.length ?? 0) >= 6 ? "+15550100000" : v
    const unqueried = v.replace(SECRET_QUERY_RE, "$1redacted")
    if (unqueried !== v) return unqueried
    // A JSON document inside a string (a fetch body): scrub inside it too.
    if ((v.startsWith("{") || v.startsWith("[")) && v.length > 1) {
      try {
        return JSON.stringify(scrubPhones(JSON.parse(v), key))
      } catch {
        return v
      }
    }
    return v
  }
  if (Array.isArray(v)) return v.map((x) => scrubPhones(x, key))
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubPhones(x, k)]),
    )
  }
  return v
}

/**
 * Replay `fixture` twice on `isolate` the way the harness does: the fixture is
 * usable when no run asks for a call it does not hold and both runs answer the
 * same. Returns the problem, or null.
 */
export async function verifyFixture(args: {
  isolate: ContractIsolate
  entry: ContractEntry
  fixture: EgressFixture
  surface: BridgeSurface
  limits: RunLimits
}): Promise<string | null> {
  const answers: string[] = []
  for (let i = 0; i < 2; i++) {
    const replay = createReplayBridge(args.surface, args.fixture)
    const outcome = await args.isolate.run({
      exportName: args.entry.exportName,
      params: args.fixture.params ?? {},
      ...(args.fixture.extraArgs ? { extraArgs: args.fixture.extraArgs } : {}),
      bridge: replay.bridge,
      limits: args.limits,
    })
    if (replay.stats.missing.length > 0) {
      return `replay asked for unrecorded calls: ${[...new Set(replay.stats.missing)].join(", ")}`
    }
    if (outcome.overrun) return `replay overran its ${outcome.overrun} limit`
    answers.push(
      canonicalJson(
        outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error },
      ),
    )
  }
  return answers[0] === answers[1] ? null : "the two replays answered differently"
}

/** `fixtures/<app>/<entry>.json`, the entry's `:` and `/` made file-safe. */
export function fixturePath(fixturesDir: string, app: string, entry: string): string {
  return join(fixturesDir, app, `${entry.replace(/[:/]/g, "__")}.json`)
}

export function writeFixture(fixturesDir: string, app: string, fixture: EgressFixture): string {
  const path = fixturePath(fixturesDir, app, fixture.entry)
  mkdirSync(join(fixturesDir, app), { recursive: true })
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`)
  return path
}
