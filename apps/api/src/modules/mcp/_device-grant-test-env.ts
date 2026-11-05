// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Side-effect-only test setup for device-grant-routes.test.ts.
//
// `device-grant-routes.ts` freezes its allowed-client set at module-import time
// (`const ALLOWED_CLIENTS = new Set(env.DEVICE_FLOW_CLIENTS)`), and `env` is
// eager-parsed the first time `~/lib/env` loads. The Strobe test runner does
// NOT load `.env.test` (the standard injected env omits DEVICE_FLOW_CLIENTS), so
// without this the allow-list is empty and `POST /mcp/device/initiate` 403s,
// failing every test in the file at the shared `initiate()` helper.
//
// Importing this module FIRST — before anything that pulls in `~/lib/env`
// (notably `~/db`) — guarantees DEVICE_FLOW_CLIENTS is populated before the
// eager env parse. `||=` preserves any value the surrounding environment
// already provides (e.g. when `.env.test` IS loaded via the orchestrator).
process.env.DEVICE_FLOW_CLIENTS ||= "*"
