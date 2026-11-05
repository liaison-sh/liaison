// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo Shopify provider's public face.
//
// The SEEDER imports this module and nothing else from the demo Shopify tree:
//
//   import { installDemoShopifyConnection }
//     from "../../apps/api/src/modules/demo/shopify"
//
// One call, after the apps are installed and enabled and the admin user exists:
//
//   await installDemoShopifyConnection({ orgId, createdByUserId: admin.userId })
//
// It is idempotent, it resets the org's store overlay, and it needs nothing else
// seeded first. The runtime half (the egress interception) wires itself: no
// seeder step turns the provider on, because the provider is on for any org
// carrying the demo marker as soon as demo mode is enabled.
export { installDemoShopifyConnection } from "./connection"
export { DEMO_SHOP_DOMAIN } from "./sentinel"
