// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo warehouse's public face.
//
// The SEEDER imports this module and nothing else from the tree:
//
//   import { installDemoWarehouseConnection, provisionDemoWarehouse }
//     from "../../apps/api/src/modules/demo/warehouse"
//
// The runtime half wires itself: `bridge.ts` asks `resolveDemoWarehouseHandle`
// on every database tool call, and that answers null for every org that is not
// a demo org on a demo box.
export { installDemoWarehouseConnection } from "./connection"
export { DemoWarehouseProvisionError, provisionDemoWarehouse } from "./provision"
export {
  DEMO_WAREHOUSE_DSN_ENV,
  DEMO_WAREHOUSE_SCHEMA,
  DEMO_WAREHOUSE_SENTINEL_DSN,
} from "./sentinel"
