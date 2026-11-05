// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Slot enumeration (Phase 17, Task B9).
 *
 * Reads the in-memory `slotRegistry` populated at app-install time by
 * `apps/api/src/modules/apps/runtime.ts` and returns the panels contributed
 * to a given slot in the requested org, filtered by the caller's scopes.
 *
 * The web shell consumes this via `GET /api/v1/slots/:slot` (see
 * `apps/api/src/modules/slots/routes.ts`) and mounts each returned panel
 * inside the slot host (e.g. the contact-detail page renders an extension
 * panel below the core metadata block).
 *
 * Slots are populated when apps' manifests declare `slots.<slot_name>.panels`
 * (or `slots.<host_app>.<slot_id>.tabs` for nested slots). The catchall
 * permits per-app slot namespaces without a schema bump.
 *
 * Per Phase 17 spec §K5: visibility is enforced by `panel.visibility_scope`
 * which must be granted to the caller (via `~/modules/permissions/permissions.hasScope`).
 * Panels without a `visibility_scope` are public-to-the-org. An app the org
 * admin turned Off (S19) contributes nothing; callers prime the org app state.
 */
import { slotRegistry } from "~/modules/apps/app-registries"
import { isAppOffForOrg } from "~/modules/apps/org-apps"
import { hasScope } from "~/modules/permissions/permissions"

export interface SlotPanel {
  id: string
  label: string
  component: string
  order?: number
  visibility_scope?: string
}

export interface ResolvedPanel extends SlotPanel {
  /** App that contributed the panel — the web shell uses this to look up the UI bundle. */
  app: string
}

export interface ListSlotPanelsOpts {
  orgId: string
  scopes: string[]
  slot: string
}

/**
 * Enumerate all panels contributed to `slot` in `orgId`, filtered by the
 * caller's scopes. Returns sorted by `order` (ascending). Never returns
 * panels from other orgs; never throws for empty registries.
 */
export function listSlotPanels(opts: ListSlotPanelsOpts): ResolvedPanel[] {
  const out: ResolvedPanel[] = []

  // Nested form: `<host>.<slot_id>.tabs` (e.g. `invoicing.document_detail.tabs`).
  // Apps contribute tabs to a host slot by declaring
  // `slots.<host>.<slot_id>.tabs` in their manifest, which the runtime stores
  // under registry key [orgId, <contributing-app>, <host>] with value
  // `{ <slot_id>: { tabs: SlotPanel[] } }`. We split the dotted slot string and
  // read the nested array. A malformed (non-three-part) slot resolves to [].
  const parts = opts.slot.split(".")
  if (parts.length > 1) {
    if (parts.length !== 3) return [] // only `<host>.<slot_id>.tabs` is supported
    const [host, slotId, kind] = parts as [string, string, string]
    for (const [key, value] of slotRegistry.entriesOf(opts.orgId)) {
      const [orgId, app, slotName] = key
      if (orgId !== opts.orgId) continue
      if (slotName !== host) continue
      // An Off app (S19) keeps its data but shows no surface, embedded ones included.
      if (isAppOffForOrg(opts.orgId, app)) continue
      const nested = (
        value as Record<string, { [k: string]: SlotPanel[] } | undefined> | undefined
      )?.[slotId]
      const tabs = nested?.[kind] ?? []
      for (const tab of tabs) {
        if (tab.visibility_scope && !hasScope(tab.visibility_scope, opts.scopes)) continue
        out.push({ ...tab, app })
      }
    }
    out.sort((a, b) => {
      const ao = a.order ?? Number.POSITIVE_INFINITY
      const bo = b.order ?? Number.POSITIVE_INFINITY
      if (ao !== bo) return ao - bo
      return a.id.localeCompare(b.id)
    })
    return out
  }

  for (const [key, value] of slotRegistry.entriesOf(opts.orgId)) {
    const [orgId, app, slotName] = key
    if (orgId !== opts.orgId) continue
    if (slotName !== opts.slot) continue
    if (isAppOffForOrg(opts.orgId, app)) continue
    // slotDef shape from the manifest: { panels?: SlotPanel[] }. Nested tabs go
    // through the `<host>.<slot_id>.tabs` branch above.
    const slotDef = value as { panels?: SlotPanel[] } | undefined
    const panels = slotDef?.panels ?? []
    for (const panel of panels) {
      if (panel.visibility_scope && !hasScope(panel.visibility_scope, opts.scopes)) continue
      out.push({ ...panel, app })
    }
  }
  out.sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY
    const bo = b.order ?? Number.POSITIVE_INFINITY
    if (ao !== bo) return ao - bo
    return a.id.localeCompare(b.id)
  })
  return out
}
