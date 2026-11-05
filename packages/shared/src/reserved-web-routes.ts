// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The first path segments of Liaison's own web pages. An app's tabs live at
 * `/<app name>` and a sandboxed app may navigate anywhere under that prefix, so
 * an app named after one of these would own a Liaison page: `/login/magic`
 * signs in with the link it carries on load, `/auth/device` approves a device.
 * Every segment here is refused as an app name at install, and the frame's
 * `navigate` refuses a target under one of them.
 *
 * Kept in step with the routes of `apps/web/src/App.tsx` and the kernel's tab
 * URL patterns by `apps/web/src/framework/reserved-web-routes.test.ts`, which
 * fails when a new top-level route is added without being reserved here.
 */
export const RESERVED_WEB_ROUTE_SEGMENTS = [
  // Signed-out pages (App.tsx), several of which act on load.
  "login",
  "register",
  "reset-password",
  "auth",
  "demo",
  // A one-time link that connects the signed-in member's own account on load.
  "connect",
  // The kernel's own tabs.
  "threads",
  "sessions",
  "import-sessions",
  "settings",
  "work",
  "chats",
  "approvals",
  "search",
  "detail",
  "agents",
  // The server's API prefix: a tab URL under it would reload into the API.
  "api",
] as const

const RESERVED = new Set<string>(RESERVED_WEB_ROUTE_SEGMENTS)

/** Is `segment` the first path segment of a Liaison page, and so not a valid app name? */
export function isReservedWebRouteSegment(segment: string): boolean {
  return RESERVED.has(segment)
}
