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

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RunLimits } from "~/modules/apps/run-limits"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import type { ContractEntry } from "./entries"
import { type BridgeSurface, outcomeProblem } from "./harness"
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
  /** A deliberate negative case (replay-bridge.ts `EgressFixture.expectError`). */
  expectError?: { reason: string }
  /** The approval the run re-enters with (replay-bridge.ts `EgressFixture.approval`): the
   *  recorder's live bridge must carry the same one. */
  approval?: Record<string, unknown>
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
      ...(input.expectError ? { expectError: input.expectError } : {}),
      ...(input.approval ? { approval: input.approval } : {}),
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
 * stand-in email is still an email. Last, the store's identity (product titles,
 * SKUs, vendors, handles, customer and company names, street addresses) becomes
 * stable invented values: `scrubStoreIdentity`.
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
  // A credential-named value (a lease token, a checkout token) goes everywhere
  // it appears, the same stand-in each time: a later call that passes it back
  // must still match its recording.
  let n = 0
  for (const secret of [...secretValues(JSON.parse(text))].sort((a, b) => b.length - a.length)) {
    if (secret.startsWith("redacted")) continue
    n++
    text = text.split(secret).join(n === 1 ? "redacted" : `redacted-${n}`)
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
  return scrubPhones(scrubStoreIdentity(JSON.parse(text)))
}

// ── Store identity ──────────────────────────────────────────────────────────
//
// A recording runs against a real store, whose catalogue and customers are not
// ours to publish. Every string held under an identity field is collected from
// the whole fixture (params, call arguments and answers, JSON inside strings
// included), then each one is replaced wherever it appears, whole or inside a
// longer string, raw or URL-encoded, by a stand-in derived from its hash: the
// same live value always gets the same stand-in, in every fixture and on every
// re-recording, so a call that passes a title or a SKU back still matches its
// recording and a re-recorded fixture does not churn.

/** Fields naming a person or a company, wherever they appear. */
const PERSON_FIELDS: Record<string, string> = {
  firstName: "Given",
  first_name: "Given",
  lastName: "Family",
  last_name: "Family",
  company: "Company",
  // A commit's or a tag's people (git hosts).
  author_name: "Customer",
  committer_name: "Customer",
}
/** A person's handle on a service (`username`, `login`): a stand-in handle. */
const HANDLE_FIELDS = new Set(["username", "login"])
/** A person's picture: its URL (a hash of their email, an upload path) becomes a stand-in. */
const AVATAR_FIELDS = new Set(["avatar_url", "avatarUrl"])
/** Fields naming a street address, wherever they appear. */
const ADDRESS_FIELDS = new Set(["address1", "address2"])
/** Keys whose presence marks an object as a product, a variant or an order line. */
const PRODUCT_MARKERS = [
  "sku",
  "vendor",
  "handle",
  "productType",
  "product_type",
  "variants",
  "variant",
  "variant_id",
  "product_id",
  "variantTitle",
  "variant_title",
  "inventoryItem",
]
/** Keys whose presence marks an object as a customer, a contact or a place (its `name` names it). */
const PERSON_MARKERS = [
  "firstName",
  "lastName",
  "first_name",
  "last_name",
  "email",
  "defaultAddress",
  "address1",
  "username",
  "login",
]
/** One stand-in `identityStandIn` makes. */
const STAND_IN =
  "(?:(?:Item|Vendor|Given|Family|Customer|Company) [0-9a-f]{8}|SKU-[0-9A-F]{8}|item-[0-9a-f]{8}|person-[0-9a-f]{8}|[0-9a-f]{8} Example Street|https://avatars\\.example\\.com/[0-9a-f]{8}\\.png)"
/** Values a recording plan writes itself, carry no identity, or are stand-ins already: they stay. */
const KEPT_IDENTITY_RE = new RegExp(
  `^(?:Default Title|Store Owner|Contract\\b.*|contract-.*|CF-.*|redacted.*|${STAND_IN}(?:[\\s,-]+${STAND_IN})*)$`,
)

function identityTag(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8)
}

/** The stand-in for one live value of the given kind. */
function identityStandIn(kind: string, value: string): string {
  const tag = identityTag(value)
  if (kind === "sku") return `SKU-${tag.toUpperCase()}`
  if (kind === "handle") return `item-${tag}`
  if (kind === "person-handle") return `person-${tag}`
  if (kind === "avatar") return `https://avatars.example.com/${tag}.png`
  if (kind === "address") return `${tag} Example Street`
  return `${kind} ${tag}`
}

/** Every identity value in `v` (JSON inside strings included), mapped to its stand-in. */
function collectIdentity(v: unknown, out: Map<string, string>): Map<string, string> {
  const add = (kind: string, x: unknown) => {
    if (typeof x !== "string") return
    const s = x.trim()
    if (s.length < 3 || !/\p{L}/u.test(s) || s.includes("@") || KEPT_IDENTITY_RE.test(s)) return
    if (s.startsWith("gid://") || /^https?:/.test(s)) return
    if (!out.has(s)) out.set(s, identityStandIn(kind, s))
  }
  if (typeof v === "string") {
    if ((v.startsWith("{") || v.startsWith("[")) && v.length > 1) {
      try {
        collectIdentity(JSON.parse(v), out)
      } catch {
        // not JSON: an ordinary string
      }
    }
  } else if (Array.isArray(v)) {
    for (const x of v) collectIdentity(x, out)
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    const product = PRODUCT_MARKERS.some((k) => k in o)
    const person = PERSON_MARKERS.some((k) => k in o)
    for (const [k, x] of Object.entries(o)) {
      if (k === "sku") add("sku", x)
      else if (k === "vendor") add("Vendor", x)
      else if (k === "company" && x && typeof x === "object")
        add("Company", (x as { name?: unknown }).name)
      else if (Object.hasOwn(PERSON_FIELDS, k)) add(PERSON_FIELDS[k] as string, x)
      else if (ADDRESS_FIELDS.has(k)) add("address", x)
      else if (HANDLE_FIELDS.has(k)) add("person-handle", x)
      else if (AVATAR_FIELDS.has(k) && typeof x === "string" && x.length > 0) {
        // A URL (absolute or a path) is otherwise kept: a person's picture is not.
        if (!KEPT_IDENTITY_RE.test(x) && !out.has(x)) out.set(x, identityStandIn("avatar", x))
      } else if (product && (k === "title" || k === "productTitle" || k === "product_title"))
        add("Item", x)
      else if (product && k === "handle") add("handle", x)
      else if (person && !product && (k === "displayName" || k === "name")) add("Customer", x)
      collectIdentity(x, out)
    }
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Replace the store's identity in `value` with stable invented stand-ins (see
 * above). Exported for the recorder's test; `scrubValue` applies it.
 */
export function scrubStoreIdentity(value: unknown): unknown {
  const found = collectIdentity(value, new Map())
  if (found.size === 0) return value
  // Each live value in the forms a string can hold it: raw, and URL-encoded.
  const pairs: Array<[string, string]> = []
  for (const [live, stand] of found) {
    pairs.push([live, stand])
    const enc = encodeURIComponent(live)
    if (enc !== live) pairs.push([enc, encodeURIComponent(stand)])
    const form = enc.replace(/%20/g, "+")
    if (form !== enc) pairs.push([form, encodeURIComponent(stand).replace(/%20/g, "+")])
  }
  // Longest first, so a title inside a longer display name is not cut in two.
  pairs.sort((a, b) => b[0].length - a[0].length)
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${pairs.map(([live]) => escapeRe(live)).join("|")})(?![\\p{L}\\p{N}])`,
    "gu",
  )
  const to = new Map(pairs)
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if ((v.startsWith("{") || v.startsWith("[")) && v.length > 1) {
        try {
          return JSON.stringify(walk(JSON.parse(v)))
        } catch {
          // not JSON: an ordinary string
        }
      }
      return v.replace(re, (m) => to.get(m) ?? m)
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]),
      )
    }
    return v
  }
  return walk(value)
}

/** Response headers a fetch fixture keeps: the ones apps read. The rest (request ids, CDN, CSP) go. */
const KEPT_RESPONSE_HEADERS = new Set([
  "content-type",
  "retry-after",
  "link",
  "location",
  // GitLab's offset pagination (bundled-apps/gitlab/src/client.ts getList).
  "x-next-page",
])

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

/** Every non-empty string held under a credential-named key, JSON inside strings included. */
function secretValues(v: unknown, key = "", out = new Set<string>()): Set<string> {
  if (typeof v === "string") {
    if (SECRET_KEY_RE.test(key) && v.length > 0) out.add(v)
    else if ((v.startsWith("{") || v.startsWith("[")) && v.length > 1) {
      try {
        secretValues(JSON.parse(v), key, out)
      } catch {
        // not JSON: an ordinary string
      }
    }
  } else if (Array.isArray(v)) {
    for (const x of v) secretValues(x, key, out)
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) secretValues(x, k, out)
  }
  return out
}

function scrubPhones(v: unknown, key = ""): unknown {
  if (typeof v === "string") {
    if (SECRET_KEY_RE.test(key) && v.length > 0 && !v.startsWith("redacted")) return "redacted"
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
 * usable when no run asks for a call it does not hold, both runs answer the
 * same, and the outcome matches its mark (harness.ts `outcomeProblem`): a run
 * that ends in an error is written only as a marked negative case, so a
 * recording of a failure is never counted as the entry working. Returns the
 * problem, or null.
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
    const problem = outcomeProblem(args.fixture, [{ outcome }])
    if (problem) return problem
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
