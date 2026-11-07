// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The minimal manifest the RPC bridge reads for a manifest-format app (its
 * schema, events, connections, network, secret placements, capabilities,
 * scope ceiling and cross-app calls), for the CLI resolving an installed app's import kind
 * without registering it (modules/imports/kinds.ts). Mirrors the
 * `manifestForBridge` registration builds in runtime.ts: keep the two field
 * lists in step.
 */

export interface BridgeManifest {
  name: string
  schema: Record<string, unknown>
  events: Record<string, unknown>
  connections: Record<string, unknown>
  network: Record<string, unknown>
  secrets: Record<string, unknown>
  capabilities: string[]
  scopes: string[]
  cross_app_calls: Array<{ target: string; reason: string }>
}

function objectOr(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : []
}

export function bridgeManifestOf(app: { name: string }): BridgeManifest {
  const desc = new Map<string, unknown>(Object.entries(app))
  return {
    name: app.name,
    schema: objectOr(desc.get("schema")),
    events: objectOr(desc.get("events")),
    connections: objectOr(desc.get("connections")),
    network: objectOr(desc.get("network")),
    // Where ctx.fetch configSecrets may place each secret (fetch-auth.ts).
    secrets: objectOr(desc.get("secrets")),
    capabilities: stringsOf(desc.get("capabilities")),
    // I9: the manifest's declared scope set, so `grants_setUserScopes` can
    // intersect app-issued grants against the app's declared ceiling. Without
    // it the intersection check is inert (an app could grant any in-namespace
    // scope).
    scopes: stringsOf(desc.get("scopes")),
    // Declared cross-app calls: the sandbox `executeTool` K4 envelope
    // translation keys off this being non-empty. Dropping it makes a Phase-17+
    // app (invoicing/boxtal) that expects `{ status, result }` silently observe
    // the legacy `{ data }` shape and misread every cross-app result.
    cross_app_calls: crossAppCallsOf(desc.get("cross_app_calls")),
  }
}

function crossAppCallsOf(v: unknown): Array<{ target: string; reason: string }> {
  return Array.isArray(v)
    ? v.filter(
        (c): c is { target: string; reason: string } =>
          c !== null &&
          typeof c === "object" &&
          typeof (c as Record<string, unknown>).target === "string",
      )
    : []
}
