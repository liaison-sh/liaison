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
export { ShopifyDiagnostics } from "./src/ui/settings"
export {
  CustomerPanel,
  ProductPanel,
  DraftOrderPanel,
  ReturnPanel,
  RefundPanel,
  MarketPanel,
} from "./src/ui/panels"
export { ShopifyHome } from "./src/ui/home"
export { ShopifySidebar } from "./src/ui/sidebar"
export { ShopifyAppIcon } from "./src/ui/icon"
export {
  ShopifyOrdersList,
  ShopifyCustomersList,
  ShopifyProductsList,
  ShopifyMarketsList,
} from "./src/ui/lists"
