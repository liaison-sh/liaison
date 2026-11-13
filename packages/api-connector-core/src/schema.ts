// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The API connector adapter format: one document describing an HTTP API as a
 * fixed list of operations the agent may call. Everything the host sends is
 * derived from this document plus validated params, so the schema is the
 * first line of the safety stack:
 *
 * - `baseUrl` is https (http only for a loopback host, which the runtime still
 *   gates behind a deployment flag); it carries no credentials, query or
 *   fragment.
 * - Paths are relative templates with no dot segments, no `%`, no `?`/`#`;
 *   every placeholder names a declared, required param.
 * - Responses are projected to `fields`, dotted paths with no wildcard; a
 *   path that is the prefix of another (an object-valued path) is refused.
 *   `fields` may instead map output names to source paths (`name:
 *   properties.name`), a source path may index an array (`emails.0.value`).
 * - A read may chain up to MAX_CHAIN_STEPS further reads of the same adapter,
 *   each fed by the previous step's projected output, never by raw response.
 * - Body templates may use the built-in `{$now}` / `{$nowMs}` and drop an
 *   object whose `$when` param is unset; neither reaches a path or query.
 * - Roles come from a fixed registry with per-role param and field rules.
 * - oauth2 token URLs live in the adapter (never a credential), https, on the
 *   baseUrl host or an explicit `tokenHost`.
 * - `redirectHosts` (optional) are hostnames under a registrable domain that a
 *   download may be redirected to; never an IP address or a public suffix.
 * - `headers` (optional) are literal headers sent on the first hop with every
 *   request; never auth, cookie, hop, proxy or forwarding headers, never a
 *   placeholder.
 * - A write may declare `approval`: what its approval card shows besides the
 *   request (a link to the target record, https on the baseUrl host or a
 *   declared `linkHosts` host; a read of the same adapter whose items are
 *   quoted as the record's current content). Nothing in it reaches a request
 *   the write sends.
 */
import { parse as parseDomain } from "tldts"
import { z } from "zod"

export const OPERATION_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
export const ADAPTER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** The adapter's display name reaches the agent's prompt: one short line, no markup. */
export const ADAPTER_NAME_MAX = 80
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const ADAPTER_NAME_RE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029<>\u0060"]+$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const ADAPTER_NAME_UNSAFE_ALL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029<>\u0060"]/g
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const FIELD_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/
const QUERY_KEY_RE = /^[A-Za-z0-9_.\-[\]]{1,128}$/
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/
/** Allowed literal characters of a path template (RFC 3986 pchar minus `%`, plus `/` and braces). */
const PATH_TEMPLATE_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/{}]*$/
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g
/** Body placeholders: a param, or a built-in value (`{$now}`, `{$nowMs}`). */
const BODY_PLACEHOLDER_RE = /\{(\$?[A-Za-z_][A-Za-z0-9_]{0,63})\}/g
/** Built-in body values: the time of rendering, as RFC 3339 UTC and as epoch milliseconds. */
export const BODY_BUILTINS = ["$now", "$nowMs"] as const
/** The body key that makes an object conditional on params being set. */
export const WHEN_KEY = "$when"
/** A chain step param fed by the previous step: exactly `{output.field}`. */
export const CHAIN_REF_RE =
  /^\{([A-Za-z_][A-Za-z0-9_-]{0,127}(?:\.[A-Za-z_][A-Za-z0-9_-]{0,127}){0,15})\}$/
const INDEX_SEGMENT_RE = /^(0|[1-9][0-9]{0,2})$/

const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "cookie",
  "expect",
])
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** Hard ceilings, shared by the host transport and the CLI. */
export const MAX_ITEMS_PER_CALL = 200
export const MAX_PAGES_PER_CALL = 5
export const MAX_ADAPTER_BYTES = 256 * 1024
export const MAX_OPERATIONS = 100
/** Further reads a chained operation may run after its own request. */
export const MAX_CHAIN_STEPS = 2
/** Items of one step a chain follows to the next step (distinct params only). */
export const MAX_CHAIN_FANOUT = 3
export const MAX_FIELDS = 200

// ---------------------------------------------------------------------------
// Role registry
// ---------------------------------------------------------------------------

export type RoleName =
  | "customer.lookup"
  | "customer.summary"
  | "customer.orders"
  | "customer.invoices"
  | "deal.list"
  | "stock.check"

export interface RoleSpec {
  description: string
  /** Every one of these params must be declared. */
  requiredParams: readonly string[]
  /** At least one of these params must be declared (empty: no rule). */
  oneOfParams: readonly string[]
  /** Every one of these fields must be in the allow-list. */
  requiredFields: readonly string[]
}

/**
 * The fixed role registry. The customer resolver calls `customer.lookup` with
 * one of email|phone|domain, then passes the matched `id` as `customerId` to
 * the per-customer roles.
 */
export const ROLE_REGISTRY: Record<RoleName, RoleSpec> = {
  "customer.lookup": {
    description: "Find customers by email, phone or domain.",
    requiredParams: [],
    oneOfParams: ["email", "phone", "domain"],
    requiredFields: ["id", "name"],
  },
  "customer.summary": {
    description: "One customer's summary, by customerId.",
    requiredParams: ["customerId"],
    oneOfParams: [],
    requiredFields: [],
  },
  "customer.orders": {
    description: "One customer's orders, by customerId.",
    requiredParams: ["customerId"],
    oneOfParams: [],
    requiredFields: ["id"],
  },
  "customer.invoices": {
    description: "One customer's invoices, by customerId.",
    requiredParams: ["customerId"],
    oneOfParams: [],
    requiredFields: ["id"],
  },
  "deal.list": {
    description: "One customer's deals, by customerId.",
    requiredParams: ["customerId"],
    oneOfParams: [],
    requiredFields: ["id"],
  },
  "stock.check": {
    description: "Stock levels, by sku or a free-text query.",
    requiredParams: [],
    oneOfParams: ["sku", "query"],
    requiredFields: [],
  },
}

export const ROLE_NAMES = Object.keys(ROLE_REGISTRY) as [RoleName, ...RoleName[]]

// ---------------------------------------------------------------------------
// Params: a JSON Schema (draft 2020-12) subset
// ---------------------------------------------------------------------------

/** Enum values are type-checked against the param type in the cross-field pass (path-precise). */
const EnumValues = z
  .array(z.union([z.string().max(200), z.number()]))
  .min(1)
  .max(100)
  .optional()

const ScalarParamSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("string"),
      description: z.string().max(500).optional(),
      enum: EnumValues,
      format: z.enum(["date", "date-time", "email", "uri", "uuid"]).optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(1).max(10_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("number"),
      description: z.string().max(500).optional(),
      enum: EnumValues,
      minimum: z.number().optional(),
      maximum: z.number().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("integer"),
      description: z.string().max(500).optional(),
      enum: EnumValues,
      minimum: z.number().int().optional(),
      maximum: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("boolean"),
      description: z.string().max(500).optional(),
    })
    .strict(),
])

const ArrayParamSchema = z
  .object({
    type: z.literal("array"),
    description: z.string().max(500).optional(),
    items: ScalarParamSchema,
    maxItems: z.number().int().min(1).max(100).optional(),
  })
  .strict()

export const ParamSchema = z.discriminatedUnion("type", [
  ...ScalarParamSchema.options,
  ArrayParamSchema,
])

export const ParamsSchema = z
  .object({
    type: z.literal("object"),
    description: z.string().max(500).optional(),
    properties: z
      .record(z.string().regex(PARAM_NAME_RE, "param names are identifiers"), ParamSchema)
      .default({}),
    required: z.array(z.string()).max(64).optional(),
    additionalProperties: z.literal(false).optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Mapping values
// ---------------------------------------------------------------------------

/** A body mapping value: a template string, a literal, or a nested structure. */
export type BodyTemplate =
  | string
  | number
  | boolean
  | null
  | BodyTemplate[]
  | { [key: string]: BodyTemplate }

const BodyTemplateSchema: z.ZodType<BodyTemplate> = z.lazy(() =>
  z.union([
    z.string().max(2000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(BodyTemplateSchema).max(100),
    z.record(z.string().max(128), BodyTemplateSchema),
  ]),
)

const JsonPointerSchema = z
  .string()
  .max(512)
  .regex(/^(\/([^~/]|~[01])*)*$/, "a JSON pointer: empty, or starting with '/'")

function isFieldPath(p: string): boolean {
  return p.split(".").every((s) => FIELD_SEGMENT_RE.test(s) && !PROTOTYPE_KEYS.has(s))
}

const FieldPathSchema = z.string().max(512).refine(isFieldPath, {
  message: "a dotted path of identifiers (no wildcard, no index, no prototype keys)",
})

/** A source path of a field map: identifiers, plus array indexes (`emails.0.value`) after the first. */
const FieldSourceSchema = z
  .string()
  .max(512)
  .refine(
    (p) => {
      const segs = p.split(".")
      return segs.every(
        (s, i) =>
          (FIELD_SEGMENT_RE.test(s) && !PROTOTYPE_KEYS.has(s)) ||
          (i > 0 && INDEX_SEGMENT_RE.test(s)),
      )
    },
    {
      message:
        "a dotted path of identifiers, with array indexes (0..999) after the first segment; no wildcard or prototype keys",
    },
  )

/**
 * The allow-list: a list of dotted paths kept as they are, or a map from an
 * output name (a dotted path) to the source path it is read from.
 */
const FieldsSchema = z.union([
  z.array(FieldPathSchema).min(1).max(MAX_FIELDS),
  z.record(z.string().max(512), FieldSourceSchema),
])

const ChainStepSchema = z
  .object({
    operation: z.string().regex(OPERATION_NAME_RE, "an operation name"),
    params: z.record(
      z.string().regex(PARAM_NAME_RE, "param names are identifiers"),
      z.union([z.string().max(2000), z.number(), z.boolean()]),
    ),
  })
  .strict()

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const HttpsUrl = z.string().max(2048)

export const AuthSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("apiKey"),
      in: z.enum(["header", "query"]),
      name: z.string(),
    })
    .strict()
    .superRefine((a, ctx) => {
      if (a.in === "header") {
        if (!HEADER_NAME_RE.test(a.name) || FORBIDDEN_HEADERS.has(a.name.toLowerCase())) {
          ctx.addIssue({ code: "custom", path: ["name"], message: "not an allowed header name" })
        }
      } else if (!QUERY_KEY_RE.test(a.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["name"],
          message: "not an allowed query parameter name",
        })
      }
    }),
  z.object({ type: z.literal("bearer") }).strict(),
  z.object({ type: z.literal("basic") }).strict(),
  z
    .object({
      type: z.literal("oauth2ClientCredentials"),
      tokenUrl: HttpsUrl,
      tokenHost: z.string().max(253).regex(HOSTNAME_RE, "a lowercase hostname").optional(),
      scope: z.string().max(1000).optional(),
    })
    .strict(),
])

export type AdapterAuth = z.infer<typeof AuthSchema>
export type AuthType = AdapterAuth["type"]

/** Every credential field name any auth type uses (for manifests and forms). */
export const ALL_CREDENTIAL_FIELDS = [
  "apiKey",
  "token",
  "username",
  "password",
  "clientId",
  "clientSecret",
] as const

/**
 * The credential fields that are secrets (the credential form's password
 * fields). Only these are redacted from what an API answers; an identifier
 * (a Basic username, an OAuth client id) passes through, so the account's own
 * name or email in an answer (a comment's author) stays readable.
 */
export const SECRET_CREDENTIAL_FIELDS: ReadonlySet<string> = new Set([
  "apiKey",
  "token",
  "password",
  "clientSecret",
])

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const PaginationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cursor"),
      param: z.string().regex(QUERY_KEY_RE),
      cursorPointer: JsonPointerSchema.refine(
        (p) => p.length > 0,
        "the cursor pointer cannot be the root",
      ),
      maxPages: z.number().int().min(1).max(MAX_PAGES_PER_CALL).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("page"),
      param: z.string().regex(QUERY_KEY_RE),
      sizeParam: z.string().regex(QUERY_KEY_RE).optional(),
      size: z.number().int().min(1).max(MAX_ITEMS_PER_CALL),
      maxPages: z.number().int().min(1).max(MAX_PAGES_PER_CALL).optional(),
    })
    .strict(),
])

// ---------------------------------------------------------------------------
// Operations and adapter
// ---------------------------------------------------------------------------

/** Items of the approval context read an approval card quotes, by default and at most. */
export const APPROVAL_CONTEXT_ITEMS_DEFAULT = 8
export const APPROVAL_CONTEXT_ITEMS_MAX = 20

/**
 * What the approval card of a write shows besides the request it sends: a
 * link to the record it writes to, and the record's current content, read at
 * staging with a read operation of the same adapter (a thread's posts before
 * a reply). Display only: nothing here reaches the write's own request.
 */
const ApprovalSchema = z
  .object({
    /** An https URL template; `{param}` placeholders name the write's declared params. */
    link: z.string().max(2048).optional(),
    linkLabel: z.string().min(1).max(60).optional(),
    context: z
      .object({
        /** A read operation of this adapter. */
        read: z.string().regex(OPERATION_NAME_RE, "an operation name"),
        /** The read's params: a literal, or a template of the write's `{param}`s. */
        params: z
          .record(
            z.string().regex(PARAM_NAME_RE, "param names are identifiers"),
            z.union([z.string().max(2000), z.number(), z.boolean()]),
          )
          .default({}),
        label: z.string().min(1).max(80).optional(),
        maxItems: z.number().int().min(1).max(APPROVAL_CONTEXT_ITEMS_MAX).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const OperationSchema = z
  .object({
    name: z
      .string()
      .regex(OPERATION_NAME_RE, "lowercase letters, digits and _ (starting with a letter), ≤ 64"),
    description: z.string().min(1).max(1000),
    kind: z.enum(["read", "write"]),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    readOnlyPost: z.boolean().optional(),
    path: z.string().max(1024),
    params: ParamsSchema,
    query: z.record(z.string().regex(QUERY_KEY_RE), z.string().max(2000)).optional(),
    body: z.record(z.string().max(128), BodyTemplateSchema).optional(),
    items: JsonPointerSchema.optional(),
    fields: FieldsSchema,
    role: z.enum(ROLE_NAMES).optional(),
    pagination: PaginationSchema.optional(),
    chain: z.array(ChainStepSchema).min(1).max(MAX_CHAIN_STEPS).optional(),
    approval: ApprovalSchema.optional(),
  })
  .strict()

export type ChainStep = z.infer<typeof ChainStepSchema>
export type OperationApproval = z.infer<typeof ApprovalSchema>
export type FieldsSpec = z.infer<typeof FieldsSchema>

/** One allow-listed field: the name it is returned under and the path it is read from. */
export interface FieldEntry {
  out: string
  source: string
}

/** The allow-list as entries (a list keeps each path under its own name). */
export function fieldEntries(op: { fields: FieldsSpec }): FieldEntry[] {
  return Array.isArray(op.fields)
    ? op.fields.map((f) => ({ out: f, source: f }))
    : Object.entries(op.fields).map(([out, source]) => ({ out, source }))
}

/** The names an operation's items carry their fields under, in the adapter's order. */
export function fieldOutputs(op: { fields: FieldsSpec }): string[] {
  return Array.isArray(op.fields) ? [...op.fields] : Object.keys(op.fields)
}

export const MAX_REDIRECT_HOSTS = 10
export const MAX_LINK_HOSTS = 10
/** Literal headers an adapter may send with every request. */
export const MAX_STATIC_HEADERS = 10
/** Static headers never set what the transport owns: auth, cookies, hops, proxies, forwarding. */
function staticHeaderNameProblem(name: string): string | null {
  const n = name.toLowerCase()
  if (!HEADER_NAME_RE.test(name)) return "is not a header name"
  if (
    FORBIDDEN_HEADERS.has(n) ||
    n === "authorization" ||
    n === "set-cookie" ||
    n === "forwarded" ||
    n === "x-real-ip" ||
    n.startsWith("proxy-") ||
    n.startsWith("x-forwarded-")
  ) {
    return "is set by the transport (auth, cookies, hops, proxies or forwarding), never by an adapter"
  }
  return null
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const STATIC_HEADER_VALUE_RE = /^[^\u0000-\u001f\u007f{}$]{1,256}$/

export const AdapterSchema = z
  .object({
    $schema: z.string().max(512).optional(),
    id: z.string().regex(ADAPTER_ID_RE, "a lowercase slug"),
    name: z
      .string()
      .min(1)
      .max(ADAPTER_NAME_MAX)
      .regex(
        ADAPTER_NAME_RE,
        "one line with no control characters, <, >, backtick or double quote",
      ),
    version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/, "a short version string"),
    description: z.string().max(2000).optional(),
    baseUrl: HttpsUrl,
    /**
     * Other hosts a download from this API may be redirected to (a media or
     * storage host), https only; the credentials are never sent there.
     */
    redirectHosts: z
      .array(z.string().max(253).regex(HOSTNAME_RE, "a lowercase hostname"))
      .max(MAX_REDIRECT_HOSTS)
      .optional(),
    /**
     * Other hosts an operation's approval link may point to (the web app of
     * the API's product, when the API has a host of its own); never an IP
     * address or a public suffix. Nothing is requested from them.
     */
    linkHosts: z
      .array(z.string().max(253).regex(HOSTNAME_RE, "a lowercase hostname"))
      .max(MAX_LINK_HOSTS)
      .optional(),
    auth: AuthSchema,
    /**
     * Literal headers sent with every request on the first hop only, like
     * auth (an API's opt-in flag). Never a credential: values cannot hold a
     * placeholder, and auth, cookie, hop, proxy and forwarding headers are
     * refused.
     */
    headers: z
      .record(z.string(), z.string())
      .refine((h) => Object.keys(h).length <= MAX_STATIC_HEADERS, {
        message: `at most ${MAX_STATIC_HEADERS} headers`,
      })
      .optional(),
    operations: z.array(OperationSchema).min(1).max(MAX_OPERATIONS),
  })
  .strict()
  .superRefine(checkAdapter)

export type Adapter = z.infer<typeof AdapterSchema>

/**
 * The display name as the agent's prompt may carry it, for a name that never
 * passed the schema (defence in depth): the characters the schema refuses
 * become spaces, runs of space collapse, and it is cut to the schema's length.
 */
export function promptSafeName(name: string): string {
  const clean = name.replace(ADAPTER_NAME_UNSAFE_ALL, " ").replace(/\s+/g, " ").trim()
  return clean.slice(0, ADAPTER_NAME_MAX).trim() || "the connected system"
}
export type Operation = Adapter["operations"][number]
export type OperationParams = Operation["params"]
export type ParamSpec = z.infer<typeof ParamSchema>
export type Pagination = z.infer<typeof PaginationSchema>

// ---------------------------------------------------------------------------
// Cross-field rules
// ---------------------------------------------------------------------------

type Ctx = z.RefinementCtx
type Path = (string | number)[]

function issue(ctx: Ctx, path: Path, message: string): void {
  ctx.addIssue({ code: "custom", path, message })
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** True for `localhost`, `127.0.0.0/8` and `[::1]`. */
export function isLoopbackHostname(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** The authority of a URL as written (between `//` and the first `/`, `?` or `#`). */
function writtenAuthority(raw: string): string {
  const at = raw.indexOf("//")
  if (at < 0) return ""
  return raw.slice(at + 2).split(/[/?#]/)[0] ?? ""
}

const DOTTED_QUAD_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
/** An IPv6 literal embedding an IPv4 address (`::ffff:a.b.c.d` mapped, `::a.b.c.d` compatible). */
const EMBEDDED_IPV4_V6_RE = /^\[::(ffff:(0:)?)?[0-9a-f]{1,4}:[0-9a-f]{1,4}\]$/i

/**
 * The rules every URL of an adapter follows (`baseUrl`, `tokenUrl`): written
 * exactly as its own normalized form (the root `/` may be left out), so what
 * an admin reads is what the host requests; no backslash, no userinfo, no
 * percent-encoded dot, and an IPv4 host only as a dotted quad (a hex, octal,
 * decimal or shortened form names an address a reader would not recognise).
 */
function urlFormProblem(raw: string): string | null {
  if (raw.includes("\\")) return "must not contain a backslash"
  if (/%2e/i.test(raw)) return "must not contain a percent-encoded dot"
  const url = parseUrl(raw)
  if (!url) return "not a URL"
  if (url.username || url.password || writtenAuthority(raw).includes("@"))
    return "must not carry credentials"
  if (DOTTED_QUAD_RE.test(url.hostname)) {
    const host = writtenAuthority(raw).replace(/:\d*$/, "")
    if (host !== url.hostname) return "must name an IPv4 host as a dotted quad"
  }
  if (url.href !== raw && url.href !== `${raw}/`) {
    return `must be written in its normalized form (${url.href})`
  }
  return null
}

/** The base URL rules; returns a message, or null when valid. */
function baseUrlProblem(raw: string): string | null {
  const form = urlFormProblem(raw)
  if (form) return form
  const url = parseUrl(raw)
  if (!url) return "not a URL"
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    return "must be https (http only for a loopback development host)"
  }
  if (url.search || raw.includes("?")) return "must not carry a query"
  if (url.hash || raw.includes("#")) return "must not carry a fragment"
  if (url.pathname.split("/").some((s) => s === ".." || s === "."))
    return "must not contain dot segments"
  return null
}

/** A tokenHost is a lowercase hostname written as its own normalized form. */
function tokenHostProblem(host: string): string | null {
  const url = parseUrl(`https://${host}/`)
  if (!url || url.hostname !== host) return "tokenHost must be written in its normalized form"
  return null
}

/**
 * A redirect host is a hostname under a registrable domain: not an IP address,
 * not a bare public suffix (`com`, `co.uk`, `github.io`), so a declaration
 * cannot open a whole suffix to redirects.
 */
export function redirectHostProblem(host: string): string | null {
  const url = parseUrl(`https://${host}/`)
  if (!url || url.hostname !== host) return "must be written in its normalized form"
  const parsed = parseDomain(host, { allowPrivateDomains: true })
  if (parsed.isIp) return "must be a hostname, not an IP address"
  if (!parsed.domain || parsed.publicSuffix === host) return "must not be a public suffix"
  return null
}

function checkAdapter(a: Adapter, ctx: Ctx): void {
  const baseProblem = baseUrlProblem(a.baseUrl)
  if (baseProblem) issue(ctx, ["baseUrl"], `baseUrl ${baseProblem}`)
  const base = baseProblem ? null : new URL(a.baseUrl)
  const seenRedirectHosts = new Set<string>()
  a.redirectHosts?.forEach((host, i) => {
    const problem = redirectHostProblem(host)
    if (problem) issue(ctx, ["redirectHosts", i], `redirect host ${problem}`)
    if (seenRedirectHosts.has(host)) issue(ctx, ["redirectHosts", i], "duplicate redirect host")
    seenRedirectHosts.add(host)
  })

  const seenLinkHosts = new Set<string>()
  a.linkHosts?.forEach((host, i) => {
    const problem = redirectHostProblem(host)
    if (problem) issue(ctx, ["linkHosts", i], `link host ${problem}`)
    if (seenLinkHosts.has(host)) issue(ctx, ["linkHosts", i], "duplicate link host")
    seenLinkHosts.add(host)
  })

  const authHeader =
    a.auth.type === "apiKey" && a.auth.in === "header" ? a.auth.name.toLowerCase() : null
  const seenHeaders = new Set<string>()
  for (const [name, value] of Object.entries(a.headers ?? {})) {
    const problem = staticHeaderNameProblem(name)
    if (problem) issue(ctx, ["headers", name], `header ${name} ${problem}`)
    else if (name.toLowerCase() === authHeader) {
      issue(ctx, ["headers", name], `header ${name} is the one the apiKey auth sets`)
    }
    if (seenHeaders.has(name.toLowerCase())) issue(ctx, ["headers", name], "duplicate header")
    seenHeaders.add(name.toLowerCase())
    if (!STATIC_HEADER_VALUE_RE.test(value)) {
      issue(
        ctx,
        ["headers", name],
        "a header value is 1 to 256 literal characters, with no line break, no { } and no $ (credentials come from the credential store only)",
      )
    }
  }

  if (a.auth.type === "oauth2ClientCredentials") {
    const tokenUrl = parseUrl(a.auth.tokenUrl)
    const tokenForm = urlFormProblem(a.auth.tokenUrl)
    if (a.auth.tokenHost !== undefined) {
      const hostIssue = tokenHostProblem(a.auth.tokenHost)
      if (hostIssue) issue(ctx, ["auth", "tokenHost"], hostIssue)
    }
    if (!tokenUrl) {
      issue(ctx, ["auth", "tokenUrl"], "tokenUrl is not a URL")
    } else if (tokenForm) {
      issue(ctx, ["auth", "tokenUrl"], `tokenUrl ${tokenForm}`)
    } else {
      const loopbackHttp = tokenUrl.protocol === "http:" && isLoopbackHostname(tokenUrl.hostname)
      if (tokenUrl.protocol !== "https:" && !loopbackHttp) {
        issue(ctx, ["auth", "tokenUrl"], "tokenUrl must be https")
      } else if (tokenUrl.username || tokenUrl.password || tokenUrl.hash) {
        issue(ctx, ["auth", "tokenUrl"], "tokenUrl must not carry credentials or a fragment")
      } else if (base) {
        const allowed = new Set([base.hostname, ...(a.auth.tokenHost ? [a.auth.tokenHost] : [])])
        if (!allowed.has(tokenUrl.hostname)) {
          issue(
            ctx,
            ["auth", "tokenUrl"],
            "tokenUrl host must be the baseUrl host or the declared tokenHost",
          )
        }
      }
    }
  }

  const seenNames = new Map<string, number>()
  const seenRoles = new Map<string, number>()
  a.operations.forEach((op, i) => {
    const at = (...rest: Path): Path => ["operations", i, ...rest]
    const prior = seenNames.get(op.name)
    if (prior !== undefined)
      issue(ctx, at("name"), `duplicate operation name (also operations.${prior})`)
    else seenNames.set(op.name, i)
    checkOperation(op, ctx, at)
    checkChain(a, op, ctx, at)
    checkApproval(a, base, op, ctx, at)
    if (op.role) {
      if (op.kind !== "read") issue(ctx, at("role"), "a role is filled by a read operation")
      const returned = new Set(finalOutputs(a, op))
      const missingFields = ROLE_REGISTRY[op.role].requiredFields.filter((f) => !returned.has(f))
      if (missingFields.length > 0) {
        issue(
          ctx,
          at(op.chain ? "chain" : "fields"),
          `role ${op.role} needs the fields ${missingFields.join(", ")}${
            op.chain ? " from the chain's last step" : ""
          }; list them, or map them (fields: { ${missingFields[0]}: <path in the response> })`,
        )
      }
      const priorRole = seenRoles.get(op.role)
      if (priorRole !== undefined)
        issue(ctx, at("role"), `role already filled by operations.${priorRole}`)
      else seenRoles.set(op.role, i)
    }
  })
}

function placeholders(template: string, re: RegExp = PLACEHOLDER_RE): string[] {
  return [...template.matchAll(re)].map((m) => m[1] ?? "")
}

/** A template string may hold placeholders only in `{name}` form; stray braces are refused. */
function strayBraces(template: string, re: RegExp = PLACEHOLDER_RE): boolean {
  return /[{}]/.test(template.replace(re, ""))
}

/**
 * The fields a call of `op` returns: its own, or, for a chained read, the
 * last step's (a step naming no read of this adapter returns none).
 */
export function finalOutputs(adapter: Pick<Adapter, "operations">, op: Operation): string[] {
  const last = op.chain?.[op.chain.length - 1]
  if (!last) return fieldOutputs(op)
  const target = adapter.operations.find((o) => o.name === last.operation)
  return target ? fieldOutputs(target) : []
}

/**
 * Each operation as the agent's catalogue and the connection summary list it:
 * the fields are what a call returns (a chained read's, its last step's).
 */
export function operationSummaries(adapter: Pick<Adapter, "operations">) {
  return adapter.operations.map((o) => ({
    name: o.name,
    kind: o.kind,
    ...(o.role ? { role: o.role } : {}),
    description: o.description,
    params: o.params,
    fields: finalOutputs(adapter, o),
  }))
}

function checkChain(a: Adapter, op: Operation, ctx: Ctx, at: (...rest: Path) => Path): void {
  if (!op.chain) return
  if (op.kind !== "read") {
    issue(ctx, at("chain"), "a chain belongs to a read operation")
    return
  }
  let previous: Operation = op
  op.chain.forEach((step, k) => {
    const stepAt = (...rest: Path): Path => at("chain", k, ...rest)
    const target = a.operations.find((o) => o.name === step.operation)
    if (!target) {
      issue(ctx, stepAt("operation"), `no operation "${step.operation}" in this adapter`)
      return
    }
    if (target.name === op.name)
      issue(ctx, stepAt("operation"), "a chain cannot call its own operation")
    if (target.kind !== "read") issue(ctx, stepAt("operation"), "a chain step runs a read")
    if (target.chain) issue(ctx, stepAt("operation"), "a chain step cannot itself be chained")
    const declared = target.params.properties
    const outputs = new Set(fieldOutputs(previous))
    for (const [name, value] of Object.entries(step.params)) {
      if (!Object.hasOwn(declared, name)) {
        issue(ctx, stepAt("params", name), `"${name}" is not a param of ${target.name}`)
        continue
      }
      if (typeof value !== "string") continue
      const ref = CHAIN_REF_RE.exec(value)
      if (ref) {
        if (!outputs.has(ref[1] ?? ""))
          issue(
            ctx,
            stepAt("params", name),
            `{${ref[1]}} is not a field of ${previous.name} (its fields: ${[...outputs].join(", ")})`,
          )
      } else if (/[{}]/.test(value)) {
        issue(
          ctx,
          stepAt("params", name),
          "a step param is a literal or exactly {field} of the previous step",
        )
      }
    }
    for (const name of target.params.required ?? []) {
      if (!Object.hasOwn(step.params, name))
        issue(ctx, stepAt("params"), `required param "${name}" of ${target.name} is not given`)
    }
    previous = target
  })
}

/** A placeholder-free stand-in for a link template, to check its shape as a URL. */
const LINK_SAMPLE_VALUE = "x"

function checkApproval(
  a: Adapter,
  base: URL | null,
  op: Operation,
  ctx: Ctx,
  at: (...rest: Path) => Path,
): void {
  const approval = op.approval
  if (!approval) return
  if (op.kind !== "write") {
    issue(
      ctx,
      at("approval"),
      "approval belongs to a write operation (it shapes its approval card)",
    )
    return
  }
  const declared = new Set(Object.keys(op.params.properties))
  if (approval.linkLabel !== undefined && approval.link === undefined)
    issue(ctx, at("approval", "linkLabel"), "linkLabel names a link: add approval.link")
  if (approval.link !== undefined) {
    const link = approval.link
    const linkAt = at("approval", "link")
    const authority = writtenAuthority(link)
    if (strayBraces(link)) issue(ctx, linkAt, "stray brace; placeholders are {param}")
    else if (/[{}]/.test(authority) || !link.startsWith("https://"))
      issue(ctx, linkAt, "the link is https, with placeholders only after the host")
    else {
      for (const name of placeholders(link)) {
        if (!declared.has(name))
          issue(ctx, linkAt, `placeholder {${name}} is not a declared param of ${op.name}`)
      }
      const sample = link.replace(PLACEHOLDER_RE, LINK_SAMPLE_VALUE)
      const url = parseUrl(sample)
      const form = urlFormProblem(sample)
      if (!url || form) issue(ctx, linkAt, `the link ${form ?? "is not a URL"}`)
      else if (url.port !== "" || url.hash !== "" || /\s/.test(link))
        issue(ctx, linkAt, "the link carries no port, fragment or whitespace")
      else if (base) {
        const allowed = new Set([base.hostname, ...(a.linkHosts ?? [])])
        if (!allowed.has(url.hostname))
          issue(
            ctx,
            linkAt,
            `the link's host must be the baseUrl host (${base.hostname}) or one of linkHosts`,
          )
      }
    }
  }
  const context = approval.context
  if (!context) return
  const contextAt = (...rest: Path): Path => at("approval", "context", ...rest)
  const target = a.operations.find((o) => o.name === context.read)
  if (!target) {
    issue(ctx, contextAt("read"), `no operation "${context.read}" in this adapter`)
    return
  }
  if (target.kind !== "read") issue(ctx, contextAt("read"), "the approval context runs a read")
  const readParams = target.params.properties
  for (const [name, value] of Object.entries(context.params)) {
    if (!Object.hasOwn(readParams, name)) {
      issue(ctx, contextAt("params", name), `"${name}" is not a param of ${target.name}`)
      continue
    }
    if (typeof value !== "string") continue
    if (strayBraces(value)) {
      issue(ctx, contextAt("params", name), "stray brace; placeholders are {param}")
      continue
    }
    for (const ref of placeholders(value)) {
      if (!declared.has(ref))
        issue(
          ctx,
          contextAt("params", name),
          `placeholder {${ref}} is not a declared param of ${op.name}`,
        )
    }
  }
  for (const name of target.params.required ?? []) {
    if (!Object.hasOwn(context.params, name))
      issue(ctx, contextAt("params"), `required param "${name}" of ${target.name} is not given`)
  }
}

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)
}

/** A param's value as one piece of text (an array joined with commas), or null when unset. */
function paramText(v: unknown): string | null {
  if (!isSet(v)) return null
  if (Array.isArray(v)) return v.map((x) => String(x)).join(",")
  return typeof v === "object" ? null : String(v)
}

/**
 * The approval link of a write for these params: each placeholder's value
 * URL-encoded. Null when the write declares no link, or a placeholder's param
 * is unset (a link to the wrong record is worse than none).
 */
export function renderApprovalLink(op: Operation, params: Record<string, unknown>): string | null {
  const link = op.approval?.link
  if (!link) return null
  let missing = false
  const url = link.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const text = paramText(params[name])
    if (text === null) {
      missing = true
      return ""
    }
    return encodeURIComponent(text)
  })
  return missing ? null : url
}

/**
 * The params of a write's approval context read: a template that is exactly
 * `{param}` takes the write param's typed value, other templates interpolate,
 * literals pass through; a template whose param is unset drops its key.
 */
export function renderApprovalContextParams(
  op: Operation,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(op.approval?.context?.params ?? {})) {
    if (typeof value !== "string") {
      out[name] = value
      continue
    }
    const exact = /^\{([A-Za-z_][A-Za-z0-9_]{0,63})\}$/.exec(value)
    if (exact) {
      const v = params[exact[1] ?? ""]
      if (isSet(v)) out[name] = v
      continue
    }
    let missing = false
    const text = value.replace(PLACEHOLDER_RE, (_m, ref: string) => {
      const t = paramText(params[ref])
      if (t === null) missing = true
      return t ?? ""
    })
    if (!missing) out[name] = text
  }
  return out
}

function checkOperation(op: Operation, ctx: Ctx, at: (...rest: Path) => Path): void {
  const declared = new Set(Object.keys(op.params.properties))
  const required = new Set(op.params.required ?? [])

  // method / kind
  if (op.kind === "read") {
    if (op.method !== "GET" && !(op.method === "POST" && op.readOnlyPost === true)) {
      issue(ctx, at("method"), "a read operation is GET, or POST with readOnlyPost: true")
    }
  }
  if (op.readOnlyPost !== undefined && !(op.kind === "read" && op.method === "POST")) {
    issue(ctx, at("readOnlyPost"), "readOnlyPost applies only to a read POST operation")
  }

  // path
  const pathOk =
    PATH_TEMPLATE_RE.test(op.path) &&
    !op.path.startsWith("//") &&
    !op.path.includes("//") &&
    !op.path.split("/").some((s) => s === "." || s === "..") &&
    !strayBraces(op.path)
  if (!pathOk) {
    issue(
      ctx,
      at("path"),
      "a relative path starting with '/': no scheme, host, '..', '%', '?', '#' or empty segment",
    )
  } else {
    for (const name of placeholders(op.path)) {
      if (!declared.has(name))
        issue(ctx, at("path"), `placeholder {${name}} is not a declared param`)
      else if (!required.has(name)) issue(ctx, at("path"), `path param {${name}} must be required`)
      else {
        const spec = op.params.properties[name]
        if (spec && spec.type === "array")
          issue(ctx, at("path"), `path param {${name}} cannot be an array`)
      }
    }
  }
  // params
  ;(op.params.required ?? []).forEach((name, j) => {
    if (!declared.has(name))
      issue(ctx, at("params", "required", j), `required param "${name}" is not declared`)
  })
  for (const [name, spec] of Object.entries(op.params.properties)) {
    const enumIssue = enumMismatch(spec)
    const enumAt =
      spec.type === "array"
        ? at("params", "properties", name, "items", "enum")
        : at("params", "properties", name, "enum")
    if (enumIssue) issue(ctx, enumAt, enumIssue)
  }

  // query
  for (const [key, template] of Object.entries(op.query ?? {})) {
    if (/\{\$/.test(template))
      issue(ctx, at("query", key), "built-in values ({$now}, {$nowMs}) are for the body only")
    else if (strayBraces(template))
      issue(ctx, at("query", key), "stray brace; placeholders are {param}")
    for (const name of placeholders(template)) {
      if (!declared.has(name))
        issue(ctx, at("query", key), `placeholder {${name}} is not a declared param`)
    }
  }

  // body
  if (op.body !== undefined && op.method === "GET")
    issue(ctx, at("body"), "a GET operation carries no body")
  if (op.body !== undefined) checkBody(op.body, declared, ctx, at("body"))
  // Every param of the body behind `$when`, none required, none in the query:
  // a call without params would send no filter at all (a page of everything).
  // A role with "at least one of" params is exempt: the host refuses such a
  // call without one of them (service).
  const roleNeedsOne = op.role ? ROLE_REGISTRY[op.role].oneOfParams.length > 0 : false
  if (op.body !== undefined && required.size === 0 && !roleNeedsOne) {
    const refs = bodyParamRefs(op.body)
    const queryRefs = Object.values(op.query ?? {}).flatMap((t) => placeholders(t))
    if (refs.guarded > 0 && refs.unguarded === 0 && queryRefs.length === 0) {
      issue(
        ctx,
        at("body"),
        "every param of the body is behind $when and none is required: a call without params would be unfiltered; require a param, or keep one filter without $when",
      )
    }
  }

  // fields: no object-valued output (a name that prefixes another)
  const outputs = fieldOutputs(op)
  const fieldAt = (j: number, f: string): Path =>
    Array.isArray(op.fields) ? at("fields", j) : at("fields", f)
  if (!Array.isArray(op.fields)) {
    if (outputs.length < 1 || outputs.length > MAX_FIELDS)
      issue(ctx, at("fields"), `a field map holds 1 to ${MAX_FIELDS} fields`)
    for (const f of outputs) {
      if (!isFieldPath(f))
        issue(
          ctx,
          at("fields", f),
          "an output name is a dotted path of identifiers (no index, no prototype keys)",
        )
    }
  }
  const fieldSet = new Set(outputs)
  outputs.forEach((f, j) => {
    for (const other of fieldSet) {
      if (other !== f && other.startsWith(`${f}.`)) {
        issue(
          ctx,
          fieldAt(j, f),
          `"${f}" is object-valued (it prefixes "${other}"); list its leaves`,
        )
        break
      }
    }
  })
  const dupField = outputs.findIndex((f, j) => outputs.indexOf(f) !== j)
  if (dupField >= 0) issue(ctx, at("fields", dupField), "duplicate field")

  // role
  if (op.role) {
    const spec = ROLE_REGISTRY[op.role]
    for (const p of spec.requiredParams) {
      if (!declared.has(p)) issue(ctx, at("params"), `role ${op.role} needs a "${p}" param`)
    }
    if (spec.oneOfParams.length > 0 && !spec.oneOfParams.some((p) => declared.has(p))) {
      issue(
        ctx,
        at("params"),
        `role ${op.role} needs one of the params ${spec.oneOfParams.join(", ")}`,
      )
    }
  }

  // pagination
  if (op.pagination) {
    if (op.kind !== "read")
      issue(ctx, at("pagination"), "pagination applies to read operations only")
    const mapped = new Set(Object.keys(op.query ?? {}))
    if (mapped.has(op.pagination.param)) {
      issue(ctx, at("pagination", "param"), "collides with a mapped query key")
    }
    if (
      op.pagination.type === "page" &&
      op.pagination.sizeParam &&
      mapped.has(op.pagination.sizeParam)
    ) {
      issue(ctx, at("pagination", "sizeParam"), "collides with a mapped query key")
    }
  }
}

function enumMismatch(spec: ParamSpec): string | null {
  if (spec.type === "array") return enumMismatch(spec.items)
  if (spec.type === "boolean" || !spec.enum) return null
  const ok =
    spec.type === "string"
      ? spec.enum.every((v) => typeof v === "string")
      : spec.type === "integer"
        ? spec.enum.every((v) => typeof v === "number" && Number.isInteger(v))
        : spec.enum.every((v) => typeof v === "number")
  return ok ? null : `enum values must all be of type ${spec.type}`
}

const BUILTIN_SET: ReadonlySet<string> = new Set(BODY_BUILTINS)

/** Param placeholders of a body, counted inside and outside `$when` objects. */
function bodyParamRefs(
  value: BodyTemplate,
  guarded = false,
): { guarded: number; unguarded: number } {
  if (typeof value === "string") {
    const n = placeholders(value, BODY_PLACEHOLDER_RE).filter((p) => !p.startsWith("$")).length
    return guarded ? { guarded: n, unguarded: 0 } : { guarded: 0, unguarded: n }
  }
  const children: [string, BodyTemplate][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : value !== null && typeof value === "object"
      ? Object.entries(value)
      : []
  const inside =
    guarded ||
    (!Array.isArray(value) &&
      value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, WHEN_KEY))
  return children.reduce(
    (acc, [k, v]) => {
      if (k === WHEN_KEY) return acc
      const r = bodyParamRefs(v, inside)
      return { guarded: acc.guarded + r.guarded, unguarded: acc.unguarded + r.unguarded }
    },
    { guarded: 0, unguarded: 0 },
  )
}

function checkBody(value: BodyTemplate, declared: Set<string>, ctx: Ctx, path: Path): void {
  if (typeof value === "string") {
    if (strayBraces(value, BODY_PLACEHOLDER_RE))
      issue(ctx, path, "stray brace; placeholders are {param}, {$now} or {$nowMs}")
    for (const name of placeholders(value, BODY_PLACEHOLDER_RE)) {
      if (name.startsWith("$")) {
        if (!BUILTIN_SET.has(name))
          issue(ctx, path, `{${name}} is not a built-in value ({$now}, {$nowMs})`)
      } else if (!declared.has(name))
        issue(ctx, path, `placeholder {${name}} is not a declared param`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      checkBody(v, declared, ctx, [...path, i])
    })
    return
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (PROTOTYPE_KEYS.has(k)) issue(ctx, [...path, k], "prototype keys are not allowed")
      if (k === WHEN_KEY) {
        const names = typeof v === "string" ? [v] : Array.isArray(v) ? v : null
        if (
          !names ||
          names.length === 0 ||
          names.length > 10 ||
          !names.every((n) => typeof n === "string" && declared.has(n))
        ) {
          issue(ctx, [...path, k], "$when names a declared param, or a list of 1 to 10 of them")
        }
        continue
      }
      checkBody(v, declared, ctx, [...path, k])
    }
  }
}

// ---------------------------------------------------------------------------
// Validation entry points
// ---------------------------------------------------------------------------

export interface AdapterIssue {
  /** Dotted path of the offending value (`operations.0.path`); empty for the root. */
  path: string
  message: string
}

export type ValidateResult = { ok: true; adapter: Adapter } | { ok: false; issues: AdapterIssue[] }

function pathOf(path: readonly PropertyKey[]): string {
  return path.map((p) => String(p)).join(".")
}

/** What the caller's deployment decides about hosts (the API passes its egress rules). */
export interface ValidateOptions {
  /**
   * The deployment allows private and loopback API hosts
   * (LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS). Without it an IPv6 literal
   * embedding an IPv4 address is refused as a base URL or token host.
   */
  allowPrivateHosts?: boolean
  /**
   * The caller's classifier for the oauth2 token host (the API reuses its
   * outbound-fetch rules: link-local and metadata addresses always refused,
   * private ones unless the deployment allows them). A message, or null.
   */
  tokenHostPolicy?: (hostname: string) => string | null
  /**
   * The document is read back from storage, not saved: the rules a stored
   * document predates (`saveOnlyIssues`) are not applied. The caller reports
   * them as warnings instead, so an adapter saved before a rule existed keeps
   * loading.
   */
  stored?: boolean
}

function hostIssues(a: Adapter, opts: ValidateOptions): AdapterIssue[] {
  const out: AdapterIssue[] = []
  const embedded = (host: string) => !opts.allowPrivateHosts && EMBEDDED_IPV4_V6_RE.test(host)
  const base = parseUrl(a.baseUrl)
  if (base && embedded(base.hostname)) {
    out.push({
      path: "baseUrl",
      message: "baseUrl must not be an IPv6 address embedding an IPv4 address",
    })
  }
  if (a.auth.type !== "oauth2ClientCredentials") return out
  const tokenUrl = parseUrl(a.auth.tokenUrl)
  const checks: [string, string | undefined][] = [
    ["auth.tokenUrl", tokenUrl?.hostname],
    ["auth.tokenHost", a.auth.tokenHost],
  ]
  for (const [path, host] of checks) {
    if (!host) continue
    if (embedded(host)) {
      out.push({
        path,
        message: "the token host must not be an IPv6 address embedding an IPv4 address",
      })
      continue
    }
    const problem = opts.tokenHostPolicy?.(host.replace(/^\[|\]$/g, ""))
    if (problem) out.push({ path, message: `the token host ${problem}` })
  }
  return out
}

/**
 * Rules a NEW document must pass that a stored one predates: a stored adapter
 * that breaks them still loads (its operations keep working as before), with
 * the issue reported as a warning; a save is refused (ValidateOptions.stored).
 *
 * A read POST without a body sends only its path and query: a param mapped to
 * neither would be dropped without a word, and the API would answer a request
 * the author never meant (a search with no filter, or a 400).
 */
export function saveOnlyIssues(adapter: Pick<Adapter, "operations">): AdapterIssue[] {
  const out: AdapterIssue[] = []
  adapter.operations.forEach((op, i) => {
    if (op.kind !== "read" || op.method !== "POST" || op.body !== undefined) return
    const sent = new Set([
      ...placeholders(op.path),
      ...Object.values(op.query ?? {}).flatMap((t) => placeholders(t)),
    ])
    const dropped = Object.keys(op.params.properties).filter((name) => !sent.has(name))
    if (dropped.length > 0) {
      out.push({
        path: `operations.${i}.body`,
        message: `this read POST has no body, so ${dropped.map((n) => `{${n}}`).join(", ")} would be sent nowhere: add the JSON body the API expects (for a search, its filters with {param} placeholders), or map them in query`,
      })
    }
  })
  return out
}

/**
 * What a valid adapter may still get wrong, said at save time without
 * refusing it. Today: a read POST that sends no body at all. Some APIs take
 * one (an RPC-style "list" call), but a search endpoint almost always needs a
 * JSON body (filters, properties, a limit) and answers 400 without it.
 */
export function adapterWarnings(adapter: Pick<Adapter, "operations">): AdapterIssue[] {
  const out: AdapterIssue[] = []
  adapter.operations.forEach((op, i) => {
    if (op.kind === "read" && op.method === "POST" && op.body === undefined) {
      out.push({
        path: `operations.${i}.body`,
        message: `${op.name} is a POST that sends no body. Most search endpoints need a JSON body (filters, properties, a limit) and answer 400 without one: check the API's docs and add body if it takes one`,
      })
    }
  })
  return out
}

export function validateAdapter(input: unknown, opts: ValidateOptions = {}): ValidateResult {
  const r = AdapterSchema.safeParse(input)
  if (!r.success) {
    return {
      ok: false,
      issues: r.error.issues.map((i) => ({ path: pathOf(i.path), message: i.message })),
    }
  }
  const issues = [...hostIssues(r.data, opts), ...(opts.stored ? [] : saveOnlyIssues(r.data))]
  return issues.length > 0 ? { ok: false, issues } : { ok: true, adapter: r.data }
}
