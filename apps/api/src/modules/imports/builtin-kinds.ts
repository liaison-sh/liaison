// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The import kinds built-in apps declare in their manifests, read statically.
 * The CLI (an operator process that never registers apps per org) resolves a
 * built-in kind here; the API resolves it from the org's import registry.
 */
import calendarManifest from "~/apps/calendar/app.manifest.json"
import contactsManifest from "~/apps/contacts/app.manifest.json"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import projectsManifest from "~/apps/projects/app.manifest.json"
import ticketsManifest from "~/apps/tickets/app.manifest.json"
import type { ImportDecl, ImportKindDecl } from "~/modules/imports/kind-schema"

const MANIFESTS: Array<{ name: string; import?: ImportDecl }> = [
  calendarManifest,
  contactsManifest,
  knowledgeManifest,
  projectsManifest,
  ticketsManifest,
]

/** Built-in kinds by full name (`tickets.ticket`). */
export const BUILTIN_IMPORT_KINDS: Readonly<Record<string, ImportKindDecl>> = Object.fromEntries(
  MANIFESTS.flatMap((m) =>
    Object.entries(m.import?.kinds ?? {}).map(([name, decl]) => [`${m.name}.${name}`, decl]),
  ),
)
