// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHERE THIS PAGE IS RUNNING, as the server's agent needs to know it.
//
// One web build runs in a browser, in the desktop shell and in the mobile
// shell. A turn the server runs has no shell on the person's computer, and the
// steps to computer mode differ by surface (get the desktop app, or switch the
// desktop app to "This machine"), so every agent message names its surface.

import type { ClientSurface } from "@liaison/shared"
import { isNativeShell } from "~/lib/native-bridge"
import { isDesktop } from "~/modules/desktop/desktop-store"

/** The desktop shell first: it is the only surface with a local runtime. */
export function currentClientSurface(): ClientSurface {
  if (isDesktop()) return "desktop"
  if (isNativeShell()) return "mobile"
  return "web"
}
