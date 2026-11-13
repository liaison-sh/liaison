// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unit-test doubles for the host's connection reads, as the sandbox bridge
// answers them: `getSettings` gives the fields the manifest marks readable and
// names the declared fields with no value (never a secret's value), and
// `getAccounts` lists an OAuth2 connection's active accounts. The secrets
// themselves reach the provider through `ctx.fetch` auth.
import { readFileSync } from "node:fs"
import { join } from "node:path"

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))

type Fields = Array<{ name: string; readable?: boolean }>
const declared = (manifest as { connections: Record<string, { credentialFields?: Fields }> })
  .connections

/** What `connections_getSettings(connection)` answers for a stored credential map. */
export function settingsFor(
  connection: string,
  stored: Record<string, string | undefined>,
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {}
  const missing: string[] = []
  for (const field of declared[connection]?.credentialFields ?? []) {
    const v = stored[field.name]
    if (typeof v !== "string" || v === "") {
      missing.push(field.name)
      continue
    }
    if (field.readable === true) values[field.name] = v
  }
  return { values, missing }
}

/** What `connections_getAccounts(connection)` answers for one connected account. */
export function oneAccount(): Array<{ id: string; identifier: string; status: string }> {
  return [{ id: "acc-1", identifier: "google-user-1", status: "active" }]
}
