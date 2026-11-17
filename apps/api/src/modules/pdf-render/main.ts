// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Entry of the `pdf-render` deploy service: `bun run src/modules/pdf-render/main.ts`.
// Reads only LIAISON_PDF_RENDER_SOCKET (no env file is given to this container).
import { chmodSync } from "node:fs"
import path from "node:path"
import { startRenderServer } from "./server"

const socket = process.env.LIAISON_PDF_RENDER_SOCKET
if (!socket) {
  console.error(
    "LIAISON_PDF_RENDER_SOCKET is not set: the render service has no socket to listen on",
  )
  process.exit(64)
}
// The socket's folder is a volume shared with the app that holds only the socket: open it to
// replace a stale socket and listen, then close it, so nothing else can be written there.
const folder = path.dirname(socket)
chmodSync(folder, 0o755)
startRenderServer(socket)
chmodSync(folder, 0o555)
console.log(`pdf render service listening on ${socket}`)
