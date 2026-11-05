// SPDX-License-Identifier: FSL-1.1-ALv2
// What the App store reads: the server's registry (`GET /apps`), the catalog
// (`GET /apps/catalog`), whether this org may install (`GET
// /apps/install-permission`) and the workspace's apps (`GET /org/apps`). The
// stores hold them; `storeItems` joins them into rows.
import type { createApiClient } from "~/lib/api-client"
import { orgAppsStore } from "../app-management/org-apps-store"
import { appsStore } from "../apps-store"
import { buildStoreItems, type StoreItem } from "./store-model"

type ApiClient = ReturnType<typeof createApiClient>

/** Load everything the store shows. A failed read leaves its part empty. */
export async function loadStoreData(api: ApiClient): Promise<void> {
  await Promise.allSettled([
    appsStore.load(api),
    appsStore.loadCatalog(api),
    appsStore.loadInstallPermission(api),
    orgAppsStore.load(api),
  ])
}

/** Reactive: the store's rows. */
export function storeItems(): StoreItem[] {
  return buildStoreItems({
    orgApps: orgAppsStore.apps(),
    registry: appsStore.apps(),
    catalog: appsStore.catalog(),
    canManageInstalls: appsStore.canManageInstalls(),
  })
}

/** Where an app's settings live: its page, or a connector's card. */
export function settingsPathFor(
  app: string,
  kind: string | undefined,
  connection?: string,
): string {
  if (kind === "connector") return `/settings/connectors?open=${encodeURIComponent(app)}`
  const base = `/settings/apps/${app}`
  return connection ? `${base}?open=${encodeURIComponent(connection)}` : base
}
