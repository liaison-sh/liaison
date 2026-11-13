// SPDX-License-Identifier: FSL-1.1-ALv2
//
// @liaison/app-sdk/connection-credentials: read a credentials connection's
// NON-SECRET settings from `ctx.connections`, whichever runtime shape it has.
//
// `ctx.connections` has two runtime shapes:
//   - FLAT   `{ getSettings(name, id?) }`: the sandbox bridge group.
//   - RECORD `{ [name]: { getSettings(id?) } }`: the SDK type and unit-test mocks.
// The raw value may arrive as a JSON string (the sandbox shim's raw path for a
// primitive arg) or as an object.
//
// App code never reads a connection's secrets (a token, an API key): the
// Workers loader and the workerd sandbox refuse `getToken` / `getCredentials`
// (`secret_not_available_on_workers`). The secrets reach the provider through
// `ctx.fetch(url, { auth })`, added host-side; the readable fields the manifest
// marks `readable: true` come from `readConnectionSettings` below.

export type ConnectionSettingsResult<K extends string> =
  | { ok: true; values: Record<string, string> }
  | {
      ok: false
      /**
       * not_connected: no accessor (or no answer) for the connection; unreadable: it threw
       * (its text is never surfaced); empty: none of `requiredKeys` holds a value;
       * incomplete: some do not (listed in `missing`). A secret is checked for presence only.
       */
      reason: "not_connected" | "unreadable" | "empty" | "incomplete"
      missing: K[]
    }

/**
 * Read the NON-SECRET settings of credentials connection `name`
 * (`getSettings`: readable values plus the names of the empty fields) and
 * check that every one of `requiredKeys` holds a value, without the secrets
 * entering the app. Both `ctx.connections` shapes; never throws for a
 * connection problem. The secrets go to the provider through `ctx.fetch` auth.
 */
export async function readConnectionSettings<K extends string>(
  connections: unknown,
  name: string,
  requiredKeys: readonly K[],
): Promise<ConnectionSettingsResult<K>> {
  let call: (() => Promise<unknown>) | null = null
  const flat = connections as {
    getSettings?: (name: string, identifier?: string) => Promise<unknown>
  }
  if (typeof flat?.getSettings === "function") {
    call = () => flat.getSettings!(name)
  } else {
    const entry = (
      connections as Record<string, { getSettings?: () => Promise<unknown> } | undefined>
    )?.[name]
    if (entry && typeof entry.getSettings === "function") call = () => entry.getSettings!()
  }
  if (!call) return { ok: false, reason: "not_connected", missing: [] }
  let settings: { values?: Record<string, string>; missing?: string[] }
  try {
    const raw = await call()
    // No answer at all: no connection to read (the host always answers an object).
    if (raw === null || raw === undefined)
      return { ok: false, reason: "not_connected", missing: [] }
    settings = (typeof raw === "string" ? JSON.parse(raw) : raw) as typeof settings
  } catch {
    return { ok: false, reason: "unreadable", missing: [] }
  }
  const values = settings.values ?? {}
  const empty = new Set(settings.missing ?? [])
  const missing = requiredKeys.filter((k) => empty.has(k))
  if (missing.length === requiredKeys.length && requiredKeys.length > 0) {
    return { ok: false, reason: "empty", missing: [] }
  }
  if (missing.length > 0) return { ok: false, reason: "incomplete", missing }
  return { ok: true, values }
}
