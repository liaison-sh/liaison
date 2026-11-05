// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH CLIENTS MAY START AN MCP DEVICE GRANT.
//
// `DEVICE_FLOW_CLIENTS` switches the headless flow on (it is empty by default,
// and the route then refuses everything with an actionable message). Once it
// is on, the product's OWN desktop app is admitted as well, whatever else the
// list names: a local session on the desktop needs an agent-scoped token and
// this grant is the only way it gets one. Deployments wrote the list for the
// CLI (`mcp-cli`) before the desktop existed, so every one of them refused the
// desktop with 403 "Unregistered device client", and the window could only
// tell the user their connection "needed to be renewed" (production,
// 2026-09-23). The client id is not a credential, anyone can send any id, so
// this widens nothing an enabled instance does not already allow: a human
// still approves every grant in the browser.

/** The client id the desktop shell initiates its grants under (`sidecar.rs`). */
export const DESKTOP_DEVICE_CLIENT_ID = "liaison-desktop"

/** What the route decides about one initiating client. */
export type DeviceClientDecision = "allowed" | "flow-disabled" | "unregistered"

export function deviceClientDecision(
  configured: ReadonlySet<string>,
  clientId: string,
): DeviceClientDecision {
  if (configured.size === 0) return "flow-disabled"
  if (configured.has("*") || configured.has(clientId)) return "allowed"
  if (clientId === DESKTOP_DEVICE_CLIENT_ID) return "allowed"
  return "unregistered"
}
