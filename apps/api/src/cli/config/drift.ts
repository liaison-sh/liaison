// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Drift safety for `liaison config apply` (the Kubernetes last-applied plus
 * Terraform plan model). PURE: no DB, no I/O; `drift-state.ts` reads the
 * server and the last-applied record, `apply.ts` drives both.
 *
 * The file stays the source of truth, but a value someone changed elsewhere
 * (the product UI, an agent) since the last apply is never overwritten
 * silently. Per tracked config path:
 *
 *  - file == server              → `unchanged` (nothing to write);
 *  - org not created yet, or the server holds no value → `create`;
 *  - no last-applied record, or server == last applied → `update`;
 *  - server != last applied (changed elsewhere) and file != server →
 *    `conflict`: the path is not written unless `--prefer file` (written,
 *    resolution `file`) or `--prefer server` (left as it is and recorded,
 *    action `keep`).
 *
 * Tracked paths are the non-secret, readable-back fields: `org.*` (name,
 * timezone, defaultLocale, requireAdminSecondFactor), `limits.<cap>`,
 * `email.from|replyTo`, `setup.features`, `roles.<name>`,
 * `apps.<name>.enable|config.<key>|settings.<path>`,
 * `agents.<handle>.<field>` and `invoicing.issuerProfiles.<legalName>.<field>`.
 * Credentials, keys, tokens and passwords are never tracked (nor hashed), and
 * neither are users, mail, tickets, knowledge, BYOK, API keys or API
 * connectors: apply writes those exactly as before.
 *
 * A path addresses array entries by their identity (`roles.<name>`,
 * `apps.<name>`, `agents.<handle without @>`), so `--only` and `--prefer`
 * name what a person reads in the file.
 */

import { createHash } from "node:crypto"
import { ORG_CAP_KINDS } from "@liaison/shared"
import { isRecord } from "~/lib/guards"
import { COMMON_AGENT_BASE_SCOPES } from "~/modules/agent/directory/common-base-scopes"
import { canonicalJson } from "~/modules/apps/app-config"

/** One step of a location: an object key, or the array entry whose `key` is `id`. */
export type Seg = string | { key: string; id: string }

export type FieldKind = "scalar" | "list" | "text" | "agentScopes" | "role" | "json" | "appEnable"

export interface TrackedField {
  /** Dotted path shown to people and matched by `--only` / `--prefer`. */
  path: string
  loc: Seg[]
  kind: FieldKind
  /** A null server value is written as `null` (meaningful: unlimited, clear),
   *  not by removing the key. */
  nullable?: boolean
}

export type DriftAction = "create" | "update" | "unchanged" | "conflict" | "keep"
export type PreferSide = "file" | "server"

export interface AppliedRecord {
  hash: string
  appliedAt: Date
  appliedBy: string
}

export interface DriftEntry {
  path: string
  action: DriftAction
  /** Set when a `--prefer` flag settled a conflict. */
  resolution?: PreferSide
  /** Short summaries; secret-like values are masked. Absent for `unchanged`. */
  file?: string
  server?: string
  lastApplied?: { at: string; by: string; matchesServer: boolean }
}

export interface PreferSpec {
  all?: PreferSide
  scoped: Array<{ path: string; side: PreferSide }>
}

/** Marker for "the org does not exist yet": nothing on the server to compare. */
export const NO_SERVER: unique symbol = Symbol("no-server")

// ── paths ────────────────────────────────────────────────────────────────

function handleId(raw: unknown): string {
  if (typeof raw !== "string") return ""
  const lower = raw.trim().toLowerCase()
  return lower.startsWith("@") ? lower.slice(1) : lower
}

function idOf(key: string, raw: unknown): string {
  if (key === "handle") return handleId(raw)
  return typeof raw === "string" ? raw : String(raw)
}

/** `o` names `path` itself, a parent of it, or a part of it. */
export function pathCovers(o: string, path: string): boolean {
  return path === o || path.startsWith(`${o}.`) || o.startsWith(`${path}.`)
}

export function inScope(path: string, only: readonly string[]): boolean {
  return only.length === 0 || only.some((o) => pathCovers(o, path))
}

/** The side a `--prefer` flag picks for `path`: the longest matching scoped
 *  flag, else the unscoped one. */
export function preferFor(spec: PreferSpec | undefined, path: string): PreferSide | undefined {
  if (!spec) return undefined
  let best: { path: string; side: PreferSide } | undefined
  for (const s of spec.scoped) {
    if (pathCovers(s.path, path) && (!best || s.path.length > best.path.length)) best = s
  }
  return best?.side ?? spec.all
}

/** Parse repeated `--prefer` values (`file`, `server`, `file=<path>`, `server=<path>`). */
export function parsePrefer(values: readonly string[]): PreferSpec | string {
  const spec: PreferSpec = { scoped: [] }
  for (const v of values) {
    const [side, ...rest] = v.split("=")
    if (side !== "file" && side !== "server") {
      return `--prefer must be file, server, file=<path> or server=<path> (got '${v}')`
    }
    const path = rest.join("=")
    if (rest.length === 0) {
      if (spec.all && spec.all !== side) return "--prefer file and --prefer server contradict"
      spec.all = side
    } else if (path === "") {
      return `--prefer ${side}= needs a path`
    } else {
      spec.scoped.push({ path, side })
    }
  }
  return spec
}

// ── locations ────────────────────────────────────────────────────────────

function matches(e: unknown, seg: { key: string; id: string }): boolean {
  return isRecord(e) && idOf(seg.key, e[seg.key]) === seg.id
}

/**
 * The JSON index path of `loc` in `root` (array entries by position), or
 * undefined when a step is missing. A list may name the same entry more than
 * once (an app listed once per connection): the apply writes them in order, so
 * a key resolves to the LAST entry that sets it.
 */
function resolve(root: unknown, loc: readonly Seg[]): Array<string | number> | undefined {
  const [seg, ...rest] = loc
  if (seg === undefined) return []
  if (typeof seg === "string") {
    if (!isRecord(root) || root[seg] === undefined) return undefined
    const tail = resolve(root[seg], rest)
    return tail && [seg, ...tail]
  }
  if (!Array.isArray(root)) return undefined
  for (let i = root.length - 1; i >= 0; i--) {
    if (!matches(root[i], seg)) continue
    const tail = resolve(root[i], rest)
    if (tail) return [i, ...tail]
  }
  return undefined
}

function walk(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let cur: unknown = root
  for (const step of path) cur = (cur as Record<string | number, unknown>)[step]
  return cur
}

/** The value at `loc`, or undefined when any step is missing. */
export function getAt(root: unknown, loc: readonly Seg[]): unknown {
  const path = resolve(root, loc)
  return path ? walk(root, path) : undefined
}

/** The JSON index path of `loc` in `root`, for a YAML document edit;
 *  undefined when a step is missing. */
export function indexPath(root: unknown, loc: readonly Seg[]): Array<string | number> | undefined {
  return resolve(root, loc)
}

/**
 * Write `value` at `loc` in a mutable config tree (the entry or object must
 * exist). An undefined value removes the key. An entry location (last step an
 * id) takes the value's keys and drops the others, keeping its identity key.
 * A key goes where it is already set, else into the last matching entry.
 */
export function setAt(root: unknown, loc: readonly Seg[], value: unknown): void {
  const last = loc[loc.length - 1]
  if (last === undefined) return
  const existing = resolve(root, loc)
  const parentPath = existing ? existing.slice(0, -1) : resolve(root, loc.slice(0, -1))
  if (!parentPath) return
  const parent = walk(root, parentPath)
  if (typeof last === "string") {
    if (!isRecord(parent)) return
    if (value === undefined) delete parent[last]
    else parent[last] = value
    return
  }
  const entry = existing ? walk(root, existing) : undefined
  if (!isRecord(entry)) return
  for (const k of Object.keys(entry)) {
    if (k !== last.key && (!isRecord(value) || !(k in value))) delete entry[k]
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) if (k !== last.key && v !== undefined) entry[k] = v
  }
}

/** Remove every array entry `loc` names (its last step must be an id). */
export function removeEntry(root: unknown, loc: readonly Seg[]): void {
  const last = loc[loc.length - 1]
  if (last === undefined || typeof last === "string") return
  const list = getAt(root, loc.slice(0, -1))
  if (!Array.isArray(list)) return
  for (let i = list.length - 1; i >= 0; i--) if (matches(list[i], last)) list.splice(i, 1)
}

// ── tracked fields ───────────────────────────────────────────────────────

/** A config key that names a secret; never tracked, never hashed. */
const SECRET_KEY_RE = /(key|token|secret|password|passphrase|credentials?)$/i
/** Shown masked in summaries (not secret, but not for a terminal either). */
const SENSITIVE_RE = /(key|token|secret|password|passphrase|credentials?|iban)$/i

const ORG_FIELDS = ["name", "timezone", "defaultLocale", "requireAdminSecondFactor"] as const
const AGENT_FIELDS: Array<[string, FieldKind]> = [
  ["displayName", "scalar"],
  ["purpose", "text"],
  ["systemPrompt", "text"],
  ["scopes", "agentScopes"],
  ["model", "scalar"],
]
/** Issuer profile keys read back by `exportIssuerProfiles` (`shopifyShop` is
 *  left out: `auto` resolves to an id, so the file and the server never match). */
const ISSUER_FIELDS = [
  "country",
  "vatId",
  "taxRegistrationId",
  "address",
  "iban",
  "swiftBic",
  "bankName",
  "defaultCurrency",
  "defaultLanguage",
  "paymentTermsDays",
  "autoEmail",
  "invoiceApprovalThresholdMinor",
  "siren",
  "siret",
  "legalForm",
  "shareCapital",
  "rcsCity",
  "vatOnDebits",
  "routingAddress",
  "addressLine1",
  "addressLine2",
  "postcode",
  "city",
  "countryCode",
] as const

function present(obj: Record<string, unknown>, key: string): boolean {
  return key in obj && obj[key] !== undefined
}

/** Every tracked path the config sets, in file order. */
export function trackedFields(config: unknown): TrackedField[] {
  if (!isRecord(config)) return []
  const out: TrackedField[] = []
  const { org, limits, email, setup, roles, apps, agents, invoicing } = config
  if (isRecord(org)) {
    for (const k of ORG_FIELDS) {
      if (present(org, k)) out.push({ path: `org.${k}`, loc: ["org", k], kind: "scalar" })
    }
  }
  if (isRecord(limits)) {
    for (const k of ORG_CAP_KINDS) {
      if (k in limits)
        out.push({ path: `limits.${k}`, loc: ["limits", k], kind: "scalar", nullable: true })
    }
  }
  if (isRecord(email)) {
    for (const k of ["from", "replyTo"]) {
      if (present(email, k)) out.push({ path: `email.${k}`, loc: ["email", k], kind: "scalar" })
    }
  }
  if (isRecord(setup) && present(setup, "features")) {
    out.push({ path: "setup.features", loc: ["setup", "features"], kind: "list" })
  }
  for (const r of Array.isArray(roles) ? roles : []) {
    if (!isRecord(r) || typeof r.name !== "string") continue
    out.push({ path: `roles.${r.name}`, loc: ["roles", { key: "name", id: r.name }], kind: "role" })
  }
  for (const a of Array.isArray(apps) ? apps : []) {
    if (!isRecord(a) || typeof a.name !== "string") continue
    const base: Seg[] = ["apps", { key: "name", id: a.name }]
    const p = `apps.${a.name}`
    out.push({ path: `${p}.enable`, loc: [...base, "enable"], kind: "appEnable" })
    if (isRecord(a.config)) {
      for (const k of Object.keys(a.config)) {
        if (SECRET_KEY_RE.test(k)) continue
        out.push({
          path: `${p}.config.${k}`,
          loc: [...base, "config", k],
          kind: "json",
          nullable: true,
        })
      }
    }
    if (isRecord(a.settings)) {
      for (const k of Object.keys(a.settings)) {
        if (SECRET_KEY_RE.test(k)) continue
        out.push({ path: `${p}.settings.${k}`, loc: [...base, "settings", k], kind: "json" })
      }
    }
  }
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!isRecord(a) || typeof a.handle !== "string") continue
    const id = handleId(a.handle)
    for (const [k, kind] of AGENT_FIELDS) {
      out.push({ path: `agents.${id}.${k}`, loc: ["agents", { key: "handle", id }, k], kind })
    }
  }
  const profiles = isRecord(invoicing) ? invoicing.issuerProfiles : undefined
  for (const prof of Array.isArray(profiles) ? profiles : []) {
    if (!isRecord(prof) || typeof prof.legalName !== "string") continue
    const base: Seg[] = ["invoicing", "issuerProfiles", { key: "legalName", id: prof.legalName }]
    for (const k of ISSUER_FIELDS) {
      if (!present(prof, k)) continue
      out.push({
        path: `invoicing.issuerProfiles.${prof.legalName}.${k}`,
        loc: [...base, k],
        kind: "scalar",
        nullable: k === "invoiceApprovalThresholdMinor",
      })
    }
  }
  // An entry listed twice (an app once per connection) yields its paths twice;
  // each path is tracked once, its value resolved across the entries.
  const seen = new Set<string>()
  return out.filter((f) => !seen.has(f.path) && seen.add(f.path))
}

// ── normalization + hashing ──────────────────────────────────────────────

const AGENT_BASE = new Set<string>(COMMON_AGENT_BASE_SCOPES)

function sortedStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").sort() : []
}

/**
 * The comparable form of a value of `field`. `fileValue` shapes a role: its
 * description is compared only when the file names one (a role without one
 * leaves the stored description alone).
 */
export function normalize(field: TrackedField, value: unknown, fileValue?: unknown): unknown {
  switch (field.kind) {
    case "scalar":
    case "json":
    case "list":
      return value === undefined ? null : value
    case "appEnable":
      return value === true
    case "text":
      return value === undefined || value === null || value === "" ? null : value
    case "agentScopes": {
      const scopes = sortedStrings(value).filter((s) => !AGENT_BASE.has(s))
      return scopes.length > 0 ? [...new Set(scopes)] : null
    }
    case "role": {
      if (!isRecord(value)) return null
      const out: Record<string, unknown> = { scopes: [...new Set(sortedStrings(value.scopes))] }
      if (isRecord(fileValue) && present(fileValue, "description")) {
        out.description = typeof value.description === "string" ? value.description : null
      }
      return out
    }
  }
}

/** A stable hash of a normalized value (`sha256:<hex>` of its canonical JSON). */
export function hashValue(normalized: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(normalized)).digest("hex")}`
}

/** A short, safe summary: masked for a secret-like path, truncated JSON otherwise. */
export function summarize(path: string, normalized: unknown): string {
  if (normalized === null) return "(not set)"
  const lastSeg = path.split(".").pop() ?? ""
  if (SENSITIVE_RE.test(lastSeg)) return `(set, ${hashValue(normalized).slice(0, 19)})`
  const text = JSON.stringify(normalized)
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

// ── decisions ────────────────────────────────────────────────────────────

export interface FieldDecision {
  field: TrackedField
  entry: DriftEntry
  /** The file's raw value (shapes how the server value is normalized). */
  fileValue: unknown
}

/** Decide one in-scope field. `server` is `NO_SERVER` when the org does not exist. */
export function decideField(opts: {
  field: TrackedField
  fileValue: unknown
  server: unknown
  record: AppliedRecord | undefined
  prefer: PreferSide | undefined
}): FieldDecision {
  const { field, fileValue, server, record, prefer } = opts
  const fileNorm = normalize(field, fileValue, fileValue)
  const decided = (entry: DriftEntry): FieldDecision => ({ field, fileValue, entry })
  const fileSummary = summarize(field.path, fileNorm)
  if (server === NO_SERVER) {
    return decided({ path: field.path, action: "create", file: fileSummary })
  }
  const serverNorm = normalize(field, server, fileValue)
  const serverHash = hashValue(serverNorm)
  if (hashValue(fileNorm) === serverHash) {
    return decided({ path: field.path, action: "unchanged" })
  }
  const entry: DriftEntry = {
    path: field.path,
    action:
      serverNorm === null || (field.kind === "appEnable" && serverNorm === false)
        ? "create"
        : "update",
    file: fileSummary,
    server: summarize(field.path, serverNorm),
  }
  if (record) {
    entry.lastApplied = {
      at: record.appliedAt.toISOString(),
      by: record.appliedBy,
      matchesServer: record.hash === serverHash,
    }
  }
  if (!record || record.hash === serverHash) return decided(entry)
  // Changed elsewhere since the last apply, and the file disagrees.
  if (prefer === "file") return decided({ ...entry, resolution: "file" })
  if (prefer === "server") {
    return decided({ ...entry, action: "keep", resolution: "server" })
  }
  return decided({ ...entry, action: "conflict" })
}

/**
 * Leave the server's value in place for `field` in a mutable config: write the
 * server value back (a no-op apply), or drop an app entry the server has off
 * (a disabled entry would fail validation, and is skipped by apply anyway).
 */
export function keepServerValue(config: unknown, field: TrackedField, server: unknown): void {
  if (field.kind === "appEnable") {
    if (server !== true) removeEntry(config, field.loc.slice(0, -1))
    return
  }
  if (server === undefined || server === null) {
    setAt(config, field.loc, field.nullable ? null : undefined)
    return
  }
  setAt(config, field.loc, server)
}

// ── --only ───────────────────────────────────────────────────────────────

/** Array sections whose entries `--only` can address by identity; `required`
 *  keys stay on an entry kept for one of its parts (no `required`: the whole
 *  entry is kept). */
const ENTRY_RULES: Record<string, { id: string; required?: string[] }> = {
  roles: { id: "name", required: ["name", "scopes"] },
  apps: { id: "name", required: ["name", "enable"] },
  agents: { id: "handle", required: ["handle", "displayName"] },
  "invoicing.issuerProfiles": { id: "legalName", required: ["legalName", "country"] },
  users: { id: "email" },
  apiKeys: { id: "label" },
  apiConnectors: { id: "identifier" },
  "mail.mailboxes": { id: "address" },
  "tickets.inboxes": { id: "address" },
  "knowledge.collections": { id: "name" },
  "invoicing.hsCodes": { id: "code" },
}

function prune(value: unknown, path: string, shape: string, only: readonly string[]): unknown {
  if (only.some((o) => path === o || path.startsWith(`${o}.`))) return value
  if (!only.some((o) => o.startsWith(`${path}.`))) return undefined
  if (Array.isArray(value)) {
    const rule = ENTRY_RULES[shape]
    if (!rule) return value
    const kept: unknown[] = []
    for (const entry of value) {
      if (!isRecord(entry)) continue
      const entryPath = `${path}.${idOf(rule.id, entry[rule.id])}`
      const whole = only.some((o) => entryPath === o || entryPath.startsWith(`${o}.`))
      if (whole || (!rule.required && only.some((o) => o.startsWith(`${entryPath}.`)))) {
        kept.push(entry)
        continue
      }
      if (!only.some((o) => o.startsWith(`${entryPath}.`))) continue
      const required = rule.required ?? []
      const out: Record<string, unknown> = {}
      for (const k of required) if (k in entry) out[k] = entry[k]
      for (const [k, v] of Object.entries(entry)) {
        if (required.includes(k)) continue
        const child = prune(v, `${entryPath}.${k}`, `${shape}[].${k}`, only)
        if (child !== undefined) out[k] = child
      }
      kept.push(out)
    }
    return kept
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const child = prune(v, `${path}.${k}`, `${shape}.${k}`, only)
      if (child !== undefined) out[k] = child
    }
    return out
  }
  return value
}

/**
 * The part of the config `--only` selects. `org` and `admin` always stay (they
 * identify the org and the acting admin; the caller keeps the server's org
 * values unless `--only org...` names them). Returns a fresh tree.
 */
export function pruneConfig(config: unknown, only: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isRecord(config)) return out
  for (const [k, v] of Object.entries(config)) {
    if (k === "org" || k === "admin") {
      out[k] = structuredClone(v)
      continue
    }
    const child = only.length === 0 ? v : prune(v, k, k, only)
    if (child !== undefined) out[k] = structuredClone(child)
  }
  return out
}
