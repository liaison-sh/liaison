// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16.5 — Frontend UI bundle entrypoint.
//
// `liaison/scripts/freeze-app.ts` looks for `<appDir>/ui.tsx` and, when
// present, bundles it as the app's frontend `ui.js` via esbuild +
// esbuild-plugin-solid (externalizing `solid-js` so the kernel +
// plugin share one Solid runtime via the import map in
// `apps/web/index.html`).
//
// The kernel's `loadManifestApps` (`apps/web/src/framework/bootstrap.ts`)
// dynamically `import()`s this bundle and reads every component name the
// manifest declares (`views.settings[].component`, `views.detail.<entity>.component`,
// `views.tabTypes.<type>.component`/`sidebar`, `views.activityBar.icon`) from
// the module's named exports. Each of those names MUST be re-exported here.

export { ShopifyHome } from "./src/ui/home"
export { ShopifyAppIcon } from "./src/ui/icon"
export {
  ShopifyCustomersList,
  ShopifyMarketsList,
  ShopifyOrdersList,
  ShopifyProductsList,
} from "./src/ui/lists"
export {
  CustomerPanel,
  DraftOrderPanel,
  MarketPanel,
  ProductPanel,
  RefundPanel,
  ReturnPanel,
} from "./src/ui/panels"
export { ShopifyDiagnostics } from "./src/ui/settings"
export { ShopifySidebar } from "./src/ui/sidebar"
