// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo's Boxtal connection: carrier quotes and shipping orders answered
// in-process for demo orgs, never put on the wire.
//
// The seeder installs the connection:
//
//   import { installDemoBoxtalConnection } from "~/modules/demo/boxtal"
//   await installDemoBoxtalConnection({ orgId, createdByUserId: admin.userId })
//
// and the sandbox fetch bridge asks `maybeDemoBoxtalResponse` before any
// Boxtal request leaves the box.
export { installDemoBoxtalConnection } from "./connection"
export { maybeDemoBoxtalResponse } from "./responder"
