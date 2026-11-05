// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo's API connection: a fixture CRM answered in-process for demo orgs.
//
// The seeder installs the connection:
//
//   import { installDemoApiConnectorConnection } from "~/modules/demo/api-connector"
//   await installDemoApiConnectorConnection({ orgId, createdByUserId: admin.userId })
//
// and the API connector routes module registers `maybeDemoApiConnectorResponse`
// into the transport's demo responder slot at load.
export { installDemoApiConnectorConnection } from "./connection"
export { forgetDemoFixtureCrm, maybeDemoApiConnectorResponse } from "./responder"
export {
  DEMO_API_CONNECTOR_BASE_URL,
  DEMO_API_CONNECTOR_IDENTIFIER,
  DEMO_API_CONNECTOR_SENTINEL_KEY,
} from "./sentinel"
