// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  getEntityExternalLink,
  getEntityOpener,
  getPanel,
  getTabType,
  namespaceRegistryKey,
  resolveRegisteredTabType,
} from "~/framework/app-registry"
import type { ApiClient } from "~/lib/api-client"
import { canOpenExternalUrl } from "~/modules/desktop/desktop-store"
import { openExternal } from "~/modules/desktop/external-links"
import { tNow } from "~/modules/i18n/i18n-context"
import { attentionStore } from "~/modules/shell/attention-store"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"

export interface OpenEntityOptions {
  markAttentionRead?: boolean
  /** Route override for the opened tab — e.g. an attention item that carries
   *  its resolved destination (metadata.settingsRoute) so the click lands on
   *  the exact settings sub-page instead of the opener's generic default. */
  routePath?: string
}

interface OpenTargetResponse {
  kind: "external" | "internal"
  url?: string
  label?: string
}

/**
 * Open an external-only entity (no in-app tab — e.g. a Shopify order) in a new
 * browser tab. The deep link needs the org connection's shop domain, resolved
 * server-side, so a blank tab is opened SYNCHRONOUSLY first (inside the click
 * gesture, before any await) to dodge the popup blocker; the placeholder is
 * navigated once the URL resolves, or closed if nothing resolves.
 */
async function openExternalEntity(
  api: ApiClient,
  app: string,
  entityType: string,
  id: string,
): Promise<void> {
  // The desktop shell has no popup blocker and no tab to pre-open: the URL
  // goes to the system browser once it resolves (modules/desktop/external-links).
  const viaShell = canOpenExternalUrl()
  let placeholder: Window | null = null
  if (!viaShell) {
    try {
      placeholder = window.open("", "_blank")
    } catch {
      placeholder = null
    }
  }
  try {
    const query = new URLSearchParams({ app, entityType, entityId: id }).toString()
    const { data } = await api.getEnvelope<OpenTargetResponse>(`/references/open-target?${query}`)
    if (data.kind === "external" && data.url) {
      if (viaShell) {
        if (!(await openExternal(data.url))) {
          addToast({ message: tNow("kernel.shellUi.couldNotOpen"), type: "error" })
        }
      } else if (placeholder) {
        try {
          placeholder.opener = null
        } catch {
          // opener may be read-only in some engines — navigating is what matters
        }
        placeholder.location.href = data.url
      } else {
        addToast({ message: tNow("kernel.shellUi.allowPopups"), type: "error" })
      }
      return
    }
  } catch (err) {
    console.warn("[entity-opener] external open-target resolution failed:", err)
  }
  // Nothing resolved (disconnected app, or no link) — don't leave a blank tab.
  placeholder?.close()
  addToast({ message: tNow("kernel.shellUi.couldNotOpen"), type: "error" })
}

/**
 * Clear the attention row for an entity, then refresh the feed. Fire-and-forget:
 * failures are logged, never surfaced, and never block whatever open action the
 * caller already performed. Shared by `openEntity` (tab opens) and the attention
 * feed's external-URL opens.
 */
export function markAttentionRead(
  api: ApiClient,
  app: string,
  entityType: string,
  entityId: string,
): void {
  try {
    api
      .post("/attention-items/mark-read", { app, entityType, entityId })
      .then(() => attentionStore.markStaleAndReload(api))
      .catch((err) => {
        console.warn("[entity-opener] attention mark-read failed:", err)
      })
  } catch (err) {
    console.warn("[entity-opener] attention mark-read sync error:", err)
  }
}

export async function openEntity(
  api: ApiClient,
  app: string,
  entityType: string,
  id: string,
  defaultLabel?: string,
  options?: OpenEntityOptions,
): Promise<void> {
  const opener = getEntityOpener(app, entityType)
  if (opener) {
    const target = await opener(api, id)
    openTab({
      type: target.tabType,
      entityId: target.entityId,
      label: target.label ?? defaultLabel ?? target.tabType,
      routePath: options?.routePath ?? target.routePath,
    })
  } else {
    const qualified = `${app}:${entityType}`
    if (getTabType(qualified)) {
      // The app registers a first-class tab type for this entity.
      openTab({ type: qualified, entityId: id, label: defaultLabel ?? qualified })
    } else if (getPanel(namespaceRegistryKey(app, `detail:${entityType}`))) {
      // The app declares an in-app detail panel (via `views.detail.<entity>`) but
      // no first-class tab type — route through the kernel's generic `detail`
      // tab, the same path the command palette uses for external app hits.
      openTab({
        type: "detail",
        entityId: `${app}/${entityType}/${id}`,
        label: defaultLabel ?? qualified,
      })
    } else if (getEntityExternalLink(app, entityType)) {
      // External-only entity (an `externalLink` with no in-app component — e.g. a
      // Shopify order, which has no order tab). Resolve its deep link server-side
      // and open it directly rather than a broken "unknown tab type" tab.
      await openExternalEntity(api, app, entityType, id)
    } else {
      // Nothing registered — open the qualified type anyway so a genuinely
      // missing registration surfaces the "unknown tab type" panel rather than
      // failing silently.
      openTab({ type: qualified, entityId: id, label: defaultLabel ?? qualified })
    }
  }

  if (options?.markAttentionRead) {
    // Marking attention-read must never break tab opening — the tab is already
    // open. Log failures at warn level so they're visible in the console
    // without surfacing an error to the user.
    markAttentionRead(api, app, entityType, id)
  }
}

/**
 * Open the destination an attention item names in `metadata.link` (surfaced as
 * `action.tabType` + `action.entityId`). The link is the destination, not the item's
 * own `app:entity`: a new-email burst is keyed `mail:new_email` but links its
 * conversation, a routine notification links its output thread. A link written as
 * `app:entity` goes through that entity's opener when one is registered; otherwise
 * the tab type opens directly (aliases such as `thread` / `settings` resolve in
 * openTab). A settings link lands on its section (`/settings/<entityId>`). The caller
 * marks the ITEM read: the link's entity id is not the item's key.
 */
export async function openAttentionLink(
  api: ApiClient,
  tabType: string,
  entityId: string,
  label?: string,
): Promise<void> {
  const sep = tabType.indexOf(":")
  if (sep > 0) {
    const app = tabType.slice(0, sep)
    const entityType = tabType.slice(sep + 1)
    if (getEntityOpener(app, entityType)) {
      await openEntity(api, app, entityType, entityId, label)
      return
    }
  }
  // Bare "settings" is an ambiguous alias (invoicing registers a local `settings`
  // tab): a link written that way means the kernel's Settings.
  const type = tabType === "settings" ? "kernel:settings" : tabType
  const resolved = resolveRegisteredTabType(type) ?? type
  if (resolved === "kernel:settings" && entityId && entityId !== "settings") {
    openTab({
      type,
      entityId,
      label: label ?? tabType,
      routePath: `/settings/${entityId}`,
    })
    return
  }
  openTab({ type, entityId, label: label ?? tabType })
}
