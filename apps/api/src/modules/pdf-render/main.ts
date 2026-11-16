// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Entry of the `pdf-render` deploy service: `bun run src/modules/pdf-render/main.ts`.
// Reads only LIAISON_PDF_RENDER_SOCKET (no env file is given to this container).
import { startRenderServer } from "./server"

const socket = process.env.LIAISON_PDF_RENDER_SOCKET
if (!socket) {
  console.error(
    "LIAISON_PDF_RENDER_SOCKET is not set: the render service has no socket to listen on",
  )
  process.exit(64)
}
startRenderServer(socket)
console.log(`pdf render service listening on ${socket}`)
