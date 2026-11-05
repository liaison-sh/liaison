// SPDX-License-Identifier: FSL-1.1-ALv2
import { manifestRegExp, wholeValueSource } from "~/lib/manifest-regex"
/**
 * Two OAuth connection knobs a manifest declares, kept free of any provider:
 *
 * - `authorizeConfigParams`: authorize-request parameters whose value is a
 *   per-deployment setting, read from the app's config (`kernel.apps.config`,
 *   a key the manifest declares in `configKeys`, written by an admin or by
 *   `config apply`). Static `extraParams` cannot carry such a value (Meta's
 *   `config_id` of a Facebook Login for Business configuration). Each value is
 *   checked against its declared, anchored pattern before it reaches a URL.
 *
 * - `identifierFromUserinfoPath`: the account identifier read at a dotted path
 *   of the `userinfoUrl` response (`data[].id`: a `[]` segment maps over an
 *   array), for providers whose sign-in can cover several accounts. One account
 *   is taken; several are never picked from silently: the flow must have been
 *   started for one of them (its id as the account hint), else the person is
 *   asked which.
 *
 * Validation of both declarations lives here too (`oauthManifestKnobErrors`,
 * run by validateAppManifest).
 */

/** One `authorizeConfigParams` entry: where the value lives and what it must look like. */
export interface AuthorizeConfigParamDecl {
  /** The app config key holding the value (declared in the manifest's `configKeys`). */
  configKey: string
  /** Anchored regular expression (`^...$`) the value must match; it is matched against the
   *  whole value (`^(?:pattern)$`), so an alternative cannot widen it. */
  pattern: string
}

/**
 * Parameters of the OAuth 2.0 / OpenID Connect protocol itself (the ones the
 * kernel sets on every authorize request, and the others that change how the
 * flow answers or whom it signs in): never a config value.
 */
export const RESERVED_AUTHORIZE_PARAMS: ReadonlySet<string> = new Set([
  "client_id",
  "client_secret",
  "redirect_uri",
  "response_type",
  "response_mode",
  "state",
  "scope",
  "code",
  "code_challenge",
  "code_challenge_method",
  "code_verifier",
  "grant_type",
  "login_hint",
  "nonce",
  "prompt",
  "id_token_hint",
  "request",
  "request_uri",
  "max_age",
  "acr_values",
])

/**
 * A declared pattern as it is matched: the WHOLE value, whatever the pattern's
 * own alternatives (`^a|.*$` must not match anything).
 */
export function wholeValuePattern(pattern: string): RegExp {
  return manifestRegExp(wholeValueSource(pattern))
}

const MAX_CONFIG_PARAM_LENGTH = 200

export type AuthorizeConfigParamsResult =
  | { ok: true; params: Record<string, string> }
  | { ok: false; configKey: string; reason: "missing" | "invalid" }

/**
 * The authorize parameters a connection's `authorizeConfigParams` yield from the
 * app's stored config, or the first one that is missing or does not match its
 * pattern (the start is then refused: nothing half-configured reaches the provider).
 */
export function resolveAuthorizeConfigParams(
  decls: Record<string, AuthorizeConfigParamDecl> | undefined,
  config: Record<string, unknown>,
): AuthorizeConfigParamsResult {
  const params: Record<string, string> = {}
  for (const [param, decl] of Object.entries(decls ?? {})) {
    const raw = config[decl.configKey]
    const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : ""
    if (!value) return { ok: false, configKey: decl.configKey, reason: "missing" }
    let re: RegExp
    try {
      re = wholeValuePattern(decl.pattern)
    } catch {
      return { ok: false, configKey: decl.configKey, reason: "invalid" }
    }
    if (value.length > MAX_CONFIG_PARAM_LENGTH || !re.test(value)) {
      return { ok: false, configKey: decl.configKey, reason: "invalid" }
    }
    params[param] = value
  }
  return { ok: true, params }
}

/** One account found in a userinfo response: its id and, when declared, its name. */
export interface UserinfoAccount {
  id: string
  name: string | null
}

/** The objects holding the last segment of `segments`, walking `[]` over arrays. */
function holdersAtPath(value: unknown, segments: string[]): Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  if (segments.length === 1) return [value as Record<string, unknown>]
  const [head, ...rest] = segments
  const each = head.endsWith("[]")
  const next = (value as Record<string, unknown>)[each ? head.slice(0, -2) : head]
  if (!each) return holdersAtPath(next, rest)
  return Array.isArray(next) ? next.flatMap((item) => holdersAtPath(item, rest)) : []
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

/**
 * The accounts at `path` of a userinfo response (`data[].id`), each with the
 * `nameField` of the same object as its name. Duplicates collapse; order kept.
 */
export function accountsAtPath(body: unknown, path: string, nameField?: string): UserinfoAccount[] {
  const segments = path.split(".")
  const idField = segments[segments.length - 1]
  if (!idField || idField.endsWith("[]")) return []
  const seen = new Set<string>()
  const out: UserinfoAccount[] = []
  for (const holder of holdersAtPath(body, segments)) {
    const id = scalarString(holder[idField])
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: nameField ? scalarString(holder[nameField]) : null })
  }
  return out
}

export type UserinfoAccountChoice =
  | { kind: "one"; account: UserinfoAccount }
  | { kind: "none" }
  | { kind: "choose"; accounts: UserinfoAccount[] }

/**
 * Which account a sign-in connects: the only one, or the one the flow was
 * started for (`hint`: its id, or its name ignoring case and a leading `@`).
 * Several and no matching hint: the person chooses, never the kernel.
 */
export function chooseUserinfoAccount(
  accounts: UserinfoAccount[],
  hint?: string | null,
): UserinfoAccountChoice {
  const wanted = hint?.trim()
  if (wanted) {
    const norm = (s: string) => s.replace(/^@/, "").toLowerCase()
    const match =
      accounts.find((a) => a.id === wanted) ??
      accounts.find((a) => a.name !== null && norm(a.name) === norm(wanted))
    if (match) return { kind: "one", account: match }
    // A hint naming no returned account is no choice at all: ask, as below.
    if (accounts.length > 0) return { kind: "choose", accounts }
  }
  if (accounts.length === 0) return { kind: "none" }
  if (accounts.length === 1) return { kind: "one", account: accounts[0] }
  return { kind: "choose", accounts }
}

/**
 * Cross-field errors of the two knobs, per connection: a config parameter's
 * name is not one the kernel sets, its key is declared in `configKeys`, its
 * pattern compiles and is anchored; an identifier path needs `userinfoUrl`
 * and no other identifier source.
 */
export function oauthManifestKnobErrors(manifest: Record<string, unknown>): string[] {
  const conns = manifest.connections
  if (!conns || typeof conns !== "object") return []
  const declaredKeys = new Set(
    (Array.isArray(manifest.configKeys) ? manifest.configKeys : []).flatMap((k) =>
      k && typeof k === "object" && typeof (k as { key?: unknown }).key === "string"
        ? [(k as { key: string }).key]
        : [],
    ),
  )
  const errors: string[] = []
  for (const [name, raw] of Object.entries(conns as Record<string, unknown>)) {
    const conn = (raw ?? {}) as Record<string, unknown>
    const params = conn.authorizeConfigParams as
      | Record<string, AuthorizeConfigParamDecl>
      | undefined
    for (const [param, decl] of Object.entries(params ?? {})) {
      const at = `connections.${name}.authorizeConfigParams.${param}`
      if (RESERVED_AUTHORIZE_PARAMS.has(param)) {
        errors.push(`${at}: "${param}" is an OAuth protocol parameter and cannot come from config`)
      }
      if (!declaredKeys.has(decl.configKey)) {
        errors.push(`${at}.configKey: "${decl.configKey}" must be declared in configKeys`)
      }
      let compiles = true
      try {
        wholeValuePattern(decl.pattern)
      } catch {
        compiles = false
      }
      if (!compiles || !decl.pattern.startsWith("^") || !decl.pattern.endsWith("$")) {
        errors.push(`${at}.pattern: must be an anchored regular expression (^...$)`)
      }
    }
    const path = conn.identifierFromUserinfoPath
    if (path !== undefined) {
      const at = `connections.${name}.identifierFromUserinfoPath`
      if (typeof conn.userinfoUrl !== "string") errors.push(`${at}: needs userinfoUrl`)
      for (const other of [
        "identifierFromUserinfoField",
        "identifierFromTokenField",
        "identifierVar",
      ]) {
        if (conn[other] !== undefined) errors.push(`${at}: cannot be combined with ${other}`)
      }
      const last = typeof path === "string" ? path.split(".").pop() : undefined
      if (!last || last.endsWith("[]")) {
        errors.push(`${at}: the last segment names the id field (e.g. data[].id)`)
      }
    }
  }
  return errors
}
