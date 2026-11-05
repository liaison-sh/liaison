// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Env-var bootstrap parser for inbound MCP connections.
//
// Spec §3.1.1. Each connection is declared as a group of
// `LIAISON_MCP_<TOKEN>_<SUFFIX>` environment variables. Longest suffix wins so
// connections whose tokens happen to start with `OAUTH` / etc. parse
// unambiguously.
//
// Connections are remote servers (http / sse). Liaison no longer runs an MCP
// server as a local command: a boot environment that still declares one
// (`_TRANSPORT=stdio`, `_STDIO_COMMAND`, `_STDIO_ARGS`, `_STDIO_ENV_<KEY>`) is
// refused at boot with an error naming the variable, never skipped.

/** Suffixes longest-first so `endsWith` anchors to the longest match. */
const SUFFIXES = [
  "OAUTH_AUTHORIZATION_URL",
  "OAUTH_CLIENT_SECRET",
  "OAUTH_CLIENT_ID",
  "OAUTH_TOKEN_URL",
  "OAUTH_SCOPES",
  "EXPOSE_VIA_GATEWAY",
  "RATE_CAP_PER_MINUTE",
  "AGENT_VISIBILITY",
  "OWNERSHIP_SCOPE",
  "OWNER_USER_ID",
  "DEFAULT_POLICY",
  "DISPLAY_NAME",
  "BEARER_TOKEN",
  "TRANSPORT",
  "ORG",
  "URL",
  "AUTH",
] as const

type Suffix = (typeof SUFFIXES)[number]

/** Suffixes of the removed local-command transport, refused by name. */
const REMOVED_STDIO_SUFFIXES = ["STDIO_COMMAND", "STDIO_ARGS"] as const

export const STDIO_MCP_REMOVED_MESSAGE =
  "MCP connections that run a local command (stdio) are no longer supported. " +
  "Remove this variable and connect the server over http or sse instead " +
  "(LIAISON_MCP_<NAME>_TRANSPORT=http with LIAISON_MCP_<NAME>_URL)."

export type Transport = "http" | "sse"
export type AuthFlavor = "none" | "bearer" | "oauth_dcr" | "oauth_static"
export type OwnershipScope = "org" | "personal"
export type AgentVisibility = "discoverable" | "hidden"
export type DefaultPolicy = "auto" | "gate_writes" | "gate_all"

export interface ParsedConnection {
  slug: string
  transport: Transport
  displayName: string
  orgId: string
  authFlavor: AuthFlavor
  ownershipScope: OwnershipScope
  ownerUserId?: string
  agentVisibility: AgentVisibility
  exposeViaGateway: boolean
  connectionDefaultPolicy: DefaultPolicy
  rateCapPerMinute?: number
  // http / sse
  httpUrl: string
  bearerToken?: string
  // oauth
  oauthClientId?: string
  oauthClientSecret?: string
  oauthAuthorizationUrl?: string
  oauthTokenUrl?: string
  oauthScopes?: string
}

export class EnvBootstrapError extends Error {
  constructor(
    public readonly varName: string,
    message: string,
  ) {
    super(`${varName}: ${message}`)
    this.name = "EnvBootstrapError"
  }
}

interface ParsedVar {
  token: string
  suffix: Suffix
  varName: string
}

function parseVar(name: string): ParsedVar | null {
  if (!name.startsWith("LIAISON_MCP_")) return null
  const tail = name.slice("LIAISON_MCP_".length)
  // The removed local-command transport: fail loudly, naming the variable.
  if (tail.indexOf("_STDIO_ENV_") > 0) throw new EnvBootstrapError(name, STDIO_MCP_REMOVED_MESSAGE)
  for (const suffix of REMOVED_STDIO_SUFFIXES) {
    if (tail.endsWith(`_${suffix}`) && tail.length > suffix.length + 1) {
      throw new EnvBootstrapError(name, STDIO_MCP_REMOVED_MESSAGE)
    }
  }
  for (const suffix of SUFFIXES) {
    const needle = `_${suffix}`
    if (tail.endsWith(needle) && tail.length > needle.length) {
      return { token: tail.slice(0, tail.length - needle.length), suffix, varName: name }
    }
  }
  throw new EnvBootstrapError(name, `unknown suffix (expected one of: ${SUFFIXES.join(", ")})`)
}

function tokenToSlug(token: string): string {
  return token.toLowerCase().replace(/_/g, "-")
}

function parseBool(varName: string, raw: string): boolean {
  if (raw === "true") return true
  if (raw === "false") return false
  throw new EnvBootstrapError(varName, `expected "true" or "false", got "${raw}"`)
}

function requireField(
  group: Record<string, string>,
  varName: string,
  field: keyof typeof group | string,
): string {
  const val = group[field as string]
  if (!val) throw new EnvBootstrapError(varName, `missing required field`)
  return val
}

export function parseEnvConnections(
  envVars: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ParsedConnection[] {
  // Group: token -> { suffix -> value }
  const groups = new Map<string, { values: Record<string, string>; firstSeenVar: string }>()

  for (const [name, rawVal] of Object.entries(envVars)) {
    if (rawVal == null) continue
    const parsed = parseVar(name)
    if (!parsed) continue
    let group = groups.get(parsed.token)
    if (!group) {
      group = { values: {}, firstSeenVar: name }
      groups.set(parsed.token, group)
    }
    group.values[parsed.suffix] = String(rawVal)
  }

  const out: ParsedConnection[] = []
  for (const [token, group] of groups) {
    const slug = tokenToSlug(token)
    const v = group.values
    const prefix = `LIAISON_MCP_${token}`

    const transport = (v.TRANSPORT ?? "") as Transport | "stdio"
    if (transport === "stdio") {
      throw new EnvBootstrapError(`${prefix}_TRANSPORT`, STDIO_MCP_REMOVED_MESSAGE)
    }
    if (transport !== "http" && transport !== "sse") {
      throw new EnvBootstrapError(
        `${prefix}_TRANSPORT`,
        `expected "http"|"sse", got "${transport || "(missing)"}"`,
      )
    }
    const displayName = requireField(v, `${prefix}_DISPLAY_NAME`, "DISPLAY_NAME")
    const orgId = requireField(v, `${prefix}_ORG`, "ORG")
    const authFlavor = (v.AUTH ?? "") as AuthFlavor
    if (
      authFlavor !== "none" &&
      authFlavor !== "bearer" &&
      authFlavor !== "oauth_dcr" &&
      authFlavor !== "oauth_static"
    ) {
      throw new EnvBootstrapError(
        `${prefix}_AUTH`,
        `expected "none"|"bearer"|"oauth_dcr"|"oauth_static", got "${authFlavor || "(missing)"}"`,
      )
    }

    const httpUrl = requireField(v, `${prefix}_URL`, "URL")

    const agentVisibility = (v.AGENT_VISIBILITY ?? "discoverable") as AgentVisibility
    if (agentVisibility !== "discoverable" && agentVisibility !== "hidden") {
      throw new EnvBootstrapError(
        `${prefix}_AGENT_VISIBILITY`,
        `expected "discoverable"|"hidden", got "${agentVisibility}"`,
      )
    }
    const exposeViaGateway = v.EXPOSE_VIA_GATEWAY
      ? parseBool(`${prefix}_EXPOSE_VIA_GATEWAY`, v.EXPOSE_VIA_GATEWAY)
      : true
    if (agentVisibility === "hidden" && !exposeViaGateway) {
      throw new EnvBootstrapError(
        `${prefix}_AGENT_VISIBILITY`,
        `connection is both hidden and not exposed via gateway — this leaves a dead, unreachable row`,
      )
    }
    const connectionDefaultPolicy = (v.DEFAULT_POLICY ?? "gate_writes") as DefaultPolicy
    if (!["auto", "gate_writes", "gate_all"].includes(connectionDefaultPolicy)) {
      throw new EnvBootstrapError(
        `${prefix}_DEFAULT_POLICY`,
        `expected "auto"|"gate_writes"|"gate_all", got "${connectionDefaultPolicy}"`,
      )
    }
    const ownershipScope = (v.OWNERSHIP_SCOPE ?? "org") as OwnershipScope
    if (ownershipScope !== "org" && ownershipScope !== "personal") {
      throw new EnvBootstrapError(
        `${prefix}_OWNERSHIP_SCOPE`,
        `expected "org"|"personal", got "${ownershipScope}"`,
      )
    }
    const rateCapPerMinute = v.RATE_CAP_PER_MINUTE
      ? Number.parseInt(v.RATE_CAP_PER_MINUTE, 10)
      : undefined
    if (rateCapPerMinute !== undefined && !Number.isFinite(rateCapPerMinute)) {
      throw new EnvBootstrapError(`${prefix}_RATE_CAP_PER_MINUTE`, `not a valid integer`)
    }

    out.push({
      slug,
      transport,
      displayName,
      orgId,
      authFlavor,
      ownershipScope,
      ownerUserId: v.OWNER_USER_ID,
      agentVisibility,
      exposeViaGateway,
      connectionDefaultPolicy,
      rateCapPerMinute,
      httpUrl,
      bearerToken: v.BEARER_TOKEN,
      oauthClientId: v.OAUTH_CLIENT_ID,
      oauthClientSecret: v.OAUTH_CLIENT_SECRET,
      oauthAuthorizationUrl: v.OAUTH_AUTHORIZATION_URL,
      oauthTokenUrl: v.OAUTH_TOKEN_URL,
      oauthScopes: v.OAUTH_SCOPES,
    })
  }
  return out
}
