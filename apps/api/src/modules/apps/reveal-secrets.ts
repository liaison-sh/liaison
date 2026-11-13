// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool that hands an operator a secret the PLATFORM minted for the app (the
// signing secret of an inbound webhook, which the operator pastes into the
// sender) never reads it: app code holds no secret on any executor
// (sandbox/bridge/secret-free.ts). The tool answers a marker where the value
// goes, `{ "$configSecret": "<config key>" }` (`configSecretReveal` in
// @liaison/app-sdk), and the host writes the value in after the run:
//
//   - only for a key the tool's manifest declaration lists in `revealsSecrets`;
//   - only for a key a connection of the app declares as its
//     `webhookSecretConfigKey` (a kernel-minted inbound secret: never an OAuth
//     client secret, a provider token or an app-held secret);
//   - never for a custom app's tool (its code is the org's, not the platform's).
//
// A marker for any other key is refused (`secret_reveal_refused`), so a tool
// cannot widen what it reveals by itself. An unset secret reads as null.

import { isCustomAppName } from "~/modules/apps/custom-app-name"
import { typedError } from "~/modules/apps/sandbox/bridge/secret-free"

export const CONFIG_SECRET_MARKER = "$configSecret"

interface ConnectionSecretKeys {
  webhookSecretConfigKey?: string
}

function markerKey(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== CONFIG_SECRET_MARKER) return null
  const key = (value as Record<string, unknown>)[CONFIG_SECRET_MARKER]
  return typeof key === "string" ? key : null
}

function hasMarker(value: unknown): boolean {
  if (markerKey(value) !== null) return true
  if (Array.isArray(value)) return value.some(hasMarker)
  if (value && typeof value === "object") return Object.values(value).some(hasMarker)
  return false
}

/**
 * Write the declared secrets into a tool's result where its markers stand.
 * `readSecret` is the host's decrypting config read (the run's own bridge
 * `config_get`, before any Workers refusal).
 */
export async function revealDeclaredSecrets(
  result: unknown,
  opts: {
    appName: string
    toolName: string
    revealsSecrets: readonly string[] | undefined
    connections: Record<string, ConnectionSecretKeys | undefined> | undefined
    readSecret: (key: string) => Promise<unknown>
  },
): Promise<unknown> {
  if (!hasMarker(result)) return result
  const minted = new Set(
    Object.values(opts.connections ?? {})
      .map((c) => c?.webhookSecretConfigKey)
      .filter((k): k is string => typeof k === "string"),
  )
  const allowed = new Set(
    isCustomAppName(opts.appName) ? [] : (opts.revealsSecrets ?? []).filter((k) => minted.has(k)),
  )
  const values = new Map<string, string | null>()
  const walk = async (value: unknown): Promise<unknown> => {
    const key = markerKey(value)
    if (key !== null) {
      if (!allowed.has(key)) {
        throw typedError(
          403,
          "secret_reveal_refused",
          `${opts.appName}.${opts.toolName} may not reveal "${key}": not a webhook secret its manifest lets this tool reveal`,
        )
      }
      if (!values.has(key)) {
        const v = await opts.readSecret(key)
        values.set(key, typeof v === "string" && v.length > 0 ? v : null)
      }
      return values.get(key) ?? null
    }
    if (Array.isArray(value)) return Promise.all(value.map(walk))
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = await walk(v)
      return out
    }
    return value
  }
  return walk(result)
}
