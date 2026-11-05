// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Request templating. `render` turns an operation plus caller params into a
 * method, a relative path, query pairs and a structural body:
 *
 * - params are validated against the operation's schema first (unknown,
 *   missing, mistyped and out-of-range values refused);
 * - each path placeholder is one URL-encoded segment; `.`/`..`, empty and
 *   control-character values are refused;
 * - query values become pairs for URLSearchParams (arrays repeat the key);
 * - the body is built as a value tree: a string that is exactly `{param}`
 *   takes the param's typed value, other strings interpolate as strings, so
 *   no caller value is ever spliced into JSON text. Two built-in values are
 *   available in the body only: `{$now}` (RFC 3339 UTC) and `{$nowMs}` (epoch
 *   milliseconds, a number when exact). An object carrying `$when: param`
 *   (or a list of params) is rendered only when every one is set, and the
 *   `$when` key itself is never sent.
 */
import { STRICT_EMAIL_RE } from "./contract"
import { type Adapter, type BodyTemplate, type Operation, type ParamSpec, WHEN_KEY } from "./schema"

/** `outside_base_url`: the rendered URL left the adapter's base URL (a host or path escape). */
export type RenderErrorCode =
  | "unknown_param"
  | "missing_param"
  | "invalid_param"
  | "outside_base_url"

export class ConnectorRenderError extends Error {
  readonly code: RenderErrorCode
  readonly param: string
  constructor(code: RenderErrorCode, param: string, message: string) {
    super(message)
    this.name = "ConnectorRenderError"
    this.code = code
    this.param = param
  }
}

export type ParamValue = string | number | boolean | (string | number | boolean)[]
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface RenderedRequest {
  method: Operation["method"]
  /** Relative path (already encoded), to append to the adapter's baseUrl path. */
  path: string
  query: [string, string][]
  body?: JsonValue
}

const EXACT_PLACEHOLDER_RE = /^\{([A-Za-z_][A-Za-z0-9_]{0,63})\}$/
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g
const BODY_EXACT_RE = /^\{(\$?[A-Za-z_][A-Za-z0-9_]{0,63})\}$/
const BODY_PLACEHOLDER_RE = /\{(\$?[A-Za-z_][A-Za-z0-9_]{0,63})\}/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/** A calendar date `YYYY-MM-DD` that exists (no 2025-02-29). */
function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

const DATE_TIME_RE =
  /^(\d{4}-\d{2}-\d{2})[Tt]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d{1,9})?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/

/** The string formats an adapter param may declare, each enforced before any request. */
const FORMAT_CHECKS: Record<
  NonNullable<Extract<ParamSpec, { type: "string" }>["format"]>,
  (s: string) => boolean
> = {
  email: (s) => STRICT_EMAIL_RE.test(s),
  date: isCalendarDate,
  "date-time": (s) => {
    const m = DATE_TIME_RE.exec(s)
    return m !== null && isCalendarDate(m[1] ?? "") && !Number.isNaN(Date.parse(s))
  },
  uri: (s) => {
    if (!URI_SCHEME_RE.test(s) || /\s/.test(s)) return false
    try {
      new URL(s)
      return true
    } catch {
      return false
    }
  },
  uuid: (s) => UUID_RE.test(s),
}

function checkScalar(
  name: string,
  spec: Exclude<ParamSpec, { type: "array" }>,
  value: unknown,
): void {
  const bad = (why: string): never => {
    throw new ConnectorRenderError("invalid_param", name, `param "${name}" ${why}`)
  }
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") bad("must be a string")
      const s = value as string
      if (spec.maxLength !== undefined && s.length > spec.maxLength)
        bad(`is longer than ${spec.maxLength}`)
      if (spec.minLength !== undefined && s.length < spec.minLength)
        bad(`is shorter than ${spec.minLength}`)
      if (spec.enum && !spec.enum.includes(s)) bad(`must be one of ${spec.enum.join(", ")}`)
      if (spec.format && !FORMAT_CHECKS[spec.format](s)) bad(`must be a valid ${spec.format}`)
      return
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) bad("must be a number")
      const n = value as number
      if (spec.type === "integer" && !Number.isInteger(n)) bad("must be an integer")
      if (spec.minimum !== undefined && n < spec.minimum) bad(`must be ≥ ${spec.minimum}`)
      if (spec.maximum !== undefined && n > spec.maximum) bad(`must be ≤ ${spec.maximum}`)
      if (spec.enum && !spec.enum.includes(n)) bad(`must be one of ${spec.enum.join(", ")}`)
      return
    }
    case "boolean":
      if (typeof value !== "boolean") bad("must be a boolean")
      return
  }
}

/**
 * The operation's param contract in one line, appended to an unknown or
 * missing param refusal so a caller corrects the call in one retry instead of
 * guessing names (e.g. a vendor's `first_name` from a read result for the
 * operation's `firstName`).
 */
export function describeParams(op: Operation): string {
  const names = Object.keys(op.params.properties)
  if (names.length === 0) return `${op.name} takes no params.`
  const required = op.params.required ?? []
  const optional = names.filter((n) => !required.includes(n))
  const parts = [
    required.length > 0 ? `required: ${required.join(", ")}` : null,
    optional.length > 0 ? `optional: ${optional.join(", ")}` : null,
  ].filter((x): x is string => x !== null)
  return `${op.name} accepts ${parts.join("; ")}.`
}

/** Validate caller params against the operation's params schema; returns the typed record. */
export function validateParams(
  op: Operation,
  params: Record<string, unknown>,
): Record<string, ParamValue> {
  const props = op.params.properties
  const out: Record<string, ParamValue> = {}
  for (const name of Object.keys(params)) {
    if (!Object.hasOwn(props, name)) {
      throw new ConnectorRenderError(
        "unknown_param",
        name,
        `unknown param "${name}" for ${op.name}. ${describeParams(op)}`,
      )
    }
  }
  for (const name of op.params.required ?? []) {
    const v = params[name]
    if (v === undefined || v === null) {
      throw new ConnectorRenderError(
        "missing_param",
        name,
        `missing required param "${name}" for ${op.name}. ${describeParams(op)}`,
      )
    }
  }
  for (const [name, spec] of Object.entries(props)) {
    if (!Object.hasOwn(params, name)) continue
    const value = params[name]
    if (value === undefined || value === null) continue
    if (spec.type === "array") {
      if (!Array.isArray(value)) {
        throw new ConnectorRenderError("invalid_param", name, `param "${name}" must be an array`)
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        throw new ConnectorRenderError(
          "invalid_param",
          name,
          `param "${name}" has more than ${spec.maxItems} items`,
        )
      }
      for (const item of value) checkScalar(name, spec.items, item)
      out[name] = value as (string | number | boolean)[]
    } else {
      checkScalar(name, spec, value)
      out[name] = value as string | number | boolean
    }
  }
  return out
}

function scalarText(name: string, value: string | number | boolean): string {
  const s = String(value)
  if (CONTROL_RE.test(s)) {
    throw new ConnectorRenderError(
      "invalid_param",
      name,
      `param "${name}" contains control characters`,
    )
  }
  return s
}

function renderPath(template: string, values: Record<string, ParamValue>): string {
  return template.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = values[name]
    if (v === undefined || Array.isArray(v)) {
      throw new ConnectorRenderError("missing_param", name, `path param "${name}" missing`)
    }
    const s = scalarText(name, v)
    if (s === "" || s === "." || s === "..") {
      throw new ConnectorRenderError(
        "invalid_param",
        name,
        `path param "${name}" cannot be empty, "." or ".."`,
      )
    }
    return encodeURIComponent(s)
  })
}

function interpolate(
  template: string,
  values: Record<string, ParamValue>,
  re: RegExp = PLACEHOLDER_RE,
): string | null {
  let missing = false
  const out = template.replace(re, (_m, name: string) => {
    const v = values[name]
    if (v === undefined) {
      missing = true
      return ""
    }
    return Array.isArray(v) ? v.map((x) => scalarText(name, x)).join(",") : scalarText(name, v)
  })
  return missing ? null : out
}

function renderQuery(
  mapping: Record<string, string>,
  values: Record<string, ParamValue>,
): [string, string][] {
  const pairs: [string, string][] = []
  for (const [key, template] of Object.entries(mapping)) {
    const exact = EXACT_PLACEHOLDER_RE.exec(template)
    if (exact) {
      const name = exact[1] ?? ""
      const v = values[name]
      if (v === undefined) continue
      if (Array.isArray(v)) for (const x of v) pairs.push([key, scalarText(name, x)])
      else pairs.push([key, scalarText(name, v)])
      continue
    }
    const s = interpolate(template, values)
    if (s !== null) pairs.push([key, s])
  }
  return pairs
}

const OMIT = Symbol("omit")

/** Every param a `$when` names is set (a malformed `$when`, refused by validation, never is). */
function whenHolds(when: BodyTemplate, values: Record<string, ParamValue>): boolean {
  const names = typeof when === "string" ? [when] : Array.isArray(when) ? when : []
  return (
    names.length > 0 &&
    names.every((n) => typeof n === "string" && !n.startsWith("$") && values[n] !== undefined)
  )
}

function renderBody(
  template: BodyTemplate,
  values: Record<string, ParamValue>,
): JsonValue | typeof OMIT {
  if (typeof template === "string") {
    const exact = BODY_EXACT_RE.exec(template)
    if (exact) {
      const v = values[exact[1] ?? ""]
      return v === undefined ? OMIT : v
    }
    const s = template.includes("{") ? interpolate(template, values, BODY_PLACEHOLDER_RE) : template
    return s === null ? OMIT : s
  }
  if (Array.isArray(template)) {
    const out: JsonValue[] = []
    for (const t of template) {
      const v = renderBody(t, values)
      if (v !== OMIT) out.push(v)
    }
    return out
  }
  if (template !== null && typeof template === "object") {
    if (Object.hasOwn(template, WHEN_KEY) && !whenHolds(template[WHEN_KEY] ?? null, values))
      return OMIT
    const out: { [key: string]: JsonValue } = {}
    for (const [k, t] of Object.entries(template)) {
      if (k === WHEN_KEY) continue
      const v = renderBody(t, values)
      if (v !== OMIT) out[k] = v
    }
    return out
  }
  return template
}

export interface RenderOptions {
  /** The time `{$now}` / `{$nowMs}` render (default: now). */
  now?: Date
}

/** Render one operation call. Throws ConnectorRenderError on bad params. */
export function render(
  op: Operation,
  params: Record<string, unknown>,
  opts: RenderOptions = {},
): RenderedRequest {
  const values = validateParams(op, params)
  const path = renderPath(op.path, values)
  const query = renderQuery(op.query ?? {}, values)
  const rendered: RenderedRequest = { method: op.method, path, query }
  if (op.body !== undefined) {
    const now = opts.now ?? new Date()
    // Built-ins are keyed `$now` / `$nowMs`: a param name never starts with `$`.
    const body = renderBody(op.body, { ...values, $now: now.toISOString(), $nowMs: now.getTime() })
    if (body !== OMIT) rendered.body = body
  }
  return rendered
}

/**
 * Resolve a rendered request against the adapter's baseUrl. The base path is
 * kept as a prefix; the result is re-checked to stay on the base host and
 * under the base path (a second line behind the schema and the encoder).
 */
export function buildRequestUrl(
  adapter: Adapter,
  req: RenderedRequest,
  extraQuery: [string, string][] = [],
): URL {
  const base = new URL(adapter.baseUrl)
  const basePath = base.pathname.replace(/\/+$/, "")
  const url = new URL(base.origin)
  url.pathname = `${basePath}${req.path}`
  const search = new URLSearchParams()
  for (const [k, v] of [...req.query, ...extraQuery]) search.append(k, v)
  url.search = search.toString()
  if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`)) {
    throw new ConnectorRenderError(
      "outside_base_url",
      "",
      "rendered URL left the adapter's base URL",
    )
  }
  return url
}
