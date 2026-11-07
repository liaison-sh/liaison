// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHERE A CONFIG SECRET MAY GO. A manifest's `secrets` map pins, per declared
// secret config key, the hosts and the one request field `ctx.fetch`'s
// `configSecrets` may write it into:
//
//   "secrets": {
//     "<configKey>": { "hosts": ["api.example.com"], "in": "body:webhookSecret" }
//   }
//
//   in: "header:<Name>"   the whole value of that request header
//       "query:<param>"   the whole value of that query parameter
//       "body:<path>"     the whole string value at that JSON path of the body
//                         (`a.b[0].c`: keys joined by dots, `[n]` an array index)
//
// The host refuses every other placement (`secret_placement_refused`); a key
// with no entry can be placed nowhere. Connection credentials (`ctx.fetch`
// auth) are not listed here: their connection's own declaration bounds them
// (its `allowedDomains`, a request header only).

import { z } from "zod"

/** One placement of a secret config key. */
export interface SecretPlacement {
  hosts: string[]
  in: string
}

export type SecretPlacementTarget =
  | { kind: "header"; name: string }
  | { kind: "query"; param: string }
  | { kind: "body"; path: Array<string | number> }

const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const QUERY_PARAM = /^[A-Za-z0-9_.~-]{1,64}$/
const PATH_KEY = /^[A-Za-z0-9_$-]{1,64}$/
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** Headers a secret may never be placed in: they frame the request, or a provider may log them. */
export const SECRET_FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "content-type",
  "cookie",
  "connection",
  "transfer-encoding",
  "user-agent",
  "referer",
  "origin",
  "x-liaison-actor",
])

/** Parse a JSON path (`a.b[0].c`) into its segments; null when it is not one. */
export function parseSecretJsonPath(raw: string): Array<string | number> | null {
  if (raw.length === 0 || raw.length > 256) return null
  const out: Array<string | number> = []
  for (const part of raw.split(".")) {
    const m = /^([^[\]]+)((?:\[\d{1,4}\])*)$/.exec(part)
    if (!m || !PATH_KEY.test(m[1]!)) return null
    out.push(m[1]!)
    for (const idx of m[2]!.match(/\d+/g) ?? []) out.push(Number(idx))
  }
  return out
}

/** The parsed `in` of a placement; null when it is not a placement. */
export function parseSecretPlacementTarget(raw: unknown): SecretPlacementTarget | null {
  if (typeof raw !== "string") return null
  if (raw.startsWith("header:")) {
    const name = raw.slice("header:".length)
    if (!HEADER_NAME.test(name) || SECRET_FORBIDDEN_HEADERS.has(name.toLowerCase())) return null
    return { kind: "header", name }
  }
  if (raw.startsWith("query:")) {
    const param = raw.slice("query:".length)
    return QUERY_PARAM.test(param) ? { kind: "query", param } : null
  }
  if (raw.startsWith("body:")) {
    const path = parseSecretJsonPath(raw.slice("body:".length))
    return path ? { kind: "body", path } : null
  }
  return null
}

export const secretPlacementSchema = z
  .object({
    hosts: z
      .array(z.string().regex(HOST_PATTERN, "a host is a lowercase name or *.<domain>"))
      .min(1, "hosts must name at least one host")
      .max(16),
    in: z.string().refine((v) => parseSecretPlacementTarget(v) !== null, {
      message: 'in must be "header:<Name>", "query:<param>" or "body:<json.path>"',
    }),
  })
  .strict()

export const appSecretsDeclarationSchema = z.record(z.string(), secretPlacementSchema)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []
}

/** Whether every host `pattern` names is one of `domains` (the same matching as the egress allowlist). */
export function hostPatternCovered(pattern: string, domains: readonly string[]): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2)
    return domains.some(
      (d) => d === pattern || (d.startsWith("*.") && suffix.endsWith(`.${d.slice(2)}`)),
    )
  }
  return domains.some((d) =>
    d.startsWith("*.") ? pattern.endsWith(`.${d.slice(2)}`) : d === pattern,
  )
}

/** The connection whose declaration names `key` as one of its secrets, with that declaration. */
function owningConnection(
  connections: unknown,
  key: string,
): { name: string; allowedDomains: string[] } | null {
  if (!isRecord(connections)) return null
  for (const [name, conn] of Object.entries(connections)) {
    if (!isRecord(conn)) continue
    if (
      conn.clientSecretConfigKey === key ||
      conn.webhookSecretConfigKey === key ||
      strings(conn.appSecretConfigKeys).includes(key)
    ) {
      return { name, allowedDomains: strings(conn.allowedDomains) }
    }
  }
  return null
}

/**
 * Cross-field problems of a manifest's `secrets` (the shape is the schema's
 * job): each key must be a secret a connection declares, and each host one the
 * app may reach with it: a host of that connection (when it names any),
 * otherwise of `network.allowedDomains`.
 */
export function secretsDeclarationErrors(manifest: unknown): string[] {
  if (!isRecord(manifest) || manifest.secrets === undefined) return []
  if (!isRecord(manifest.secrets)) return ["secrets must be an object keyed by config key"]
  const errors: string[] = []
  const network = isRecord(manifest.network) ? strings(manifest.network.allowedDomains) : []
  for (const [key, placement] of Object.entries(manifest.secrets)) {
    const owner = owningConnection(manifest.connections, key)
    if (!owner) {
      errors.push(`secrets.${key}: not a secret config key a connection declares`)
      continue
    }
    if (!isRecord(placement)) continue
    const domains = owner.allowedDomains.length > 0 ? owner.allowedDomains : network
    for (const host of strings(placement.hosts)) {
      if (!hostPatternCovered(host, domains)) {
        errors.push(
          `secrets.${key}.hosts: ${host} is not a host of connection "${owner.name}"` +
            (owner.allowedDomains.length > 0 ? "" : " or of network.allowedDomains"),
        )
      }
    }
  }
  return errors
}
