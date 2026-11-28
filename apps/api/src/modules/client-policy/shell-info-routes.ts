// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/shell/info, UNAUTHENTICATED.
//
// The desktop and phone apps can run this server's own web build in their main
// window instead of the one compiled into them, once they have checked a signed
// statement published for that build id (packages/shared/src/app-signing/
// shell-statement.ts). This route tells them which build ids the server ships:
// the desktop build (served at `/`) and the native build (served under
// `/native/`, null when the image carries none), with the release name, the
// settings page format version and the operator's kill switch.
//
// `servedShell` (LIAISON_SERVED_SHELL, default true) is that switch: false asks
// every app on this server to keep its bundled shell. It is a request, not a
// control: a signature check, not this flag, is what keeps an unsigned build
// out. Never cached, so flipping it reaches the next launch.
import { SETTINGS_SCHEMA_VERSION } from "@liaison/app-sdk"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { env } from "~/lib/env"
import { success } from "~/lib/response"
import { shellBuildIds } from "~/lib/web-shell-builds"

export interface ShellInfo {
  desktop: { buildId: string | null }
  native: { buildId: string } | null
  liaisonVersion: string
  settingsSchema: number
  servedShell: boolean
}

export function currentShellInfo(): ShellInfo {
  const ids = shellBuildIds()
  return {
    desktop: { buildId: ids.desktop },
    native: ids.native ? { buildId: ids.native } : null,
    liaisonVersion: env.LIAISON_VERSION,
    settingsSchema: SETTINGS_SCHEMA_VERSION,
    servedShell: env.LIAISON_SERVED_SHELL,
  }
}

export const shellInfoRoutes = new Hono<AppEnv>()

shellInfoRoutes.get("/info", (c) => {
  c.header("Cache-Control", "no-store")
  return success(c, currentShellInfo())
})
