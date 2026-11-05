// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE FRAME DOCUMENT A BROWSER TAB RUNS AN OUTSIDE APP'S INTERFACE IN (S16, A23).
//
// An app that is not first-party never runs in the web page: the page holds the
// user's session, and the app's code would run with it. The page frames it
// instead (apps/web framework/isolated-app.tsx, `sandbox="allow-scripts
// allow-forms"`, never `allow-same-origin`: an opaque origin, no cookie, no
// storage, no API of its own) and answers its frame-protocol calls for that app
// only. The desktop shell serves this document on its own scheme, the phone as a
// file of its build; a browser has neither, so the server serves it here, at
// `/api/apps/<name>/<version>/frame`, for the active version of a vouched-for
// outside app, against the same short-lived token as its `ui.js`.
//
// The document is the shells' one (`appFrameDocument`, @liaison/shared): the
// frame runtime the web build emits beside its pages (`app-frame-runtime.js`)
// inlined under a fresh nonce. Its policy goes out as a RESPONSE HEADER (a meta
// element cannot carry `frame-ancestors`): scripts only from that runtime and
// the blobs it makes from the bundle the page hands it, no network, no frame, no
// form, framed only by this server's own pages.
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { appFrameDocument, appFramePolicy } from "@liaison/shared"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"

/** The runtime file the web build writes beside index.html (apps/web scripts/build-app-frame.ts). */
const APP_FRAME_RUNTIME_FILE = "app-frame-runtime.js"

/** Where the bundled web build lives (lib/server.ts serves it from the same place). */
function publicDir(): string {
  return (
    process.env.LIAISON_PUBLIC_DIR || fileURLToPath(new URL("../../../public", import.meta.url))
  )
}

let runtime: Promise<string | null> | null = null

async function loadRuntime(): Promise<string | null> {
  const file = join(publicDir(), APP_FRAME_RUNTIME_FILE)
  if (existsSync(file)) return readFileSync(file, "utf8")
  // A production image bundles the web build; without it there is no frame.
  if (env.NODE_ENV === "production") {
    log.warn({ file }, "app frame runtime missing: outside apps cannot run in a browser tab")
    return null
  }
  // Development and tests run the API from source with no bundled web build:
  // build the runtime from the web app's source, once per process.
  const script = fileURLToPath(
    new URL("../../../../web/scripts/build-app-frame.ts", import.meta.url),
  )
  const { bundleAppFrameRuntime } = (await import(script)) as {
    bundleAppFrameRuntime: () => Promise<string>
  }
  return bundleAppFrameRuntime()
}

/** The frame runtime's text, read once (the image is immutable); null when there is none. */
export function appFrameRuntime(): Promise<string | null> {
  if (!runtime) {
    runtime = loadRuntime().catch((err) => {
      log.warn({ err }, "app frame runtime could not be loaded")
      runtime = null
      return null
    })
  }
  return runtime
}

/** Tests: forget the runtime read so a changed public dir is read again. */
export function resetAppFrameRuntime(): void {
  runtime = null
}

/**
 * The policy the document is served under, with what only a header carries:
 * `frame-ancestors`, and `sandbox`, so the document is sandboxed to an opaque
 * origin even if something frames it without the iframe's own sandbox.
 */
export function appFrameHeaderPolicy(nonce: string): string {
  return `${appFramePolicy(nonce)}; frame-ancestors 'self'; sandbox allow-scripts allow-forms`
}

/** The frame document's response, with its policy as a header. */
export function appFrameResponse(runtimeText: string): Response {
  const nonce = randomBytes(18).toString("hex")
  return new Response(appFrameDocument(runtimeText, nonce), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": appFrameHeaderPolicy(nonce),
      // The security middleware keeps a route's own framing rule; every other
      // response stays DENY. Browsers that know `frame-ancestors` use it instead.
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  })
}
