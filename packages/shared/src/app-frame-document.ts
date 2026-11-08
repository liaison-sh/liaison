// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DOCUMENT AN OUTSIDE APP'S UI RUNS IN, as the phone and the browser get it.
//
// One document, the frame runtime (apps/web/src/app-frame/runtime.ts, built into
// one classic script) inlined under a nonce, and one policy: no script but that
// runtime and the blobs it makes from the bundle the page hands it, no network
// (`connect-src 'none'`: every call goes through the page, which answers it for
// that app only), no image or frame from anywhere, no form. The desktop shell
// serves the same runtime under the same policy on its own scheme
// (apps/desktop/src-tauri/src/app_frame.rs `frame_policy`).
//
// - the phone writes the document as a file of its build (apps/web
//   scripts/build-app-frame.ts `--native`), the policy as a meta element;
// - the server serves it to a browser tab (apps/api modules/apps/app-frame.ts),
//   the policy as a response header too, with the `frame-ancestors` a meta
//   element cannot carry.
//
// The nonce keeps markup out, not code: the only scripts in the frame are the
// runtime and the app bundle it is handed, which runs anyway.

/** What a frame document served on an app's own origin adds (apps/api app-frame-host-route.ts). */
export interface AppFrameDocumentOptions {
  /**
   * The page's origin: the one window the frame runtime posts to and listens to
   * (`<meta name="liaison-parent-origin">`). Absent, the runtime answers its parent
   * window whatever its origin (an opaque frame, a shell's frame).
   */
  parentOrigin?: string
  /** `https://host` image sources the app's manifest declares (`network.imageHosts`). */
  imgSources?: readonly string[]
}

/** An image source the policy may name: `https://host` or `https://*.host`, nothing else. */
const IMG_SOURCE =
  /^https:\/\/(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

/** The frame's policy, less what a meta element cannot carry (`frame-ancestors`). */
export function appFramePolicy(nonce: string, options: AppFrameDocumentOptions = {}): string {
  const images = (options.imgSources ?? []).filter((source) => IMG_SOURCE.test(source))
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' blob:`,
    "style-src 'unsafe-inline'",
    `img-src data: blob:${images.map((source) => ` ${source}`).join("")}`,
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ")
}

/** The frame document: the policy first, then the runtime under its nonce. */
export function appFrameDocument(
  runtime: string,
  nonce: string,
  options: AppFrameDocumentOptions = {},
): string {
  // `</script` inside the runtime would end the element early.
  const safe = runtime.replace(/<\/script/gi, "<\\/script")
  const parent = parentOriginMeta(options.parentOrigin)
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8" />',
    `<meta http-equiv="Content-Security-Policy" content="${appFramePolicy(nonce, options)}" />`,
    ...(parent ? [parent] : []),
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<meta name="referrer" content="no-referrer" />',
    "<title>App</title>",
    "</head>",
    "<body>",
    '<div id="app"></div>',
    `<script nonce="${nonce}">${safe}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n")
}

/** The parent-origin meta element, for an exact http(s) origin only; null otherwise. */
function parentOriginMeta(origin: string | undefined): string | null {
  if (!origin) return null
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol) || url.origin !== origin) return null
  return `<meta name="liaison-parent-origin" content="${url.origin}" />`
}
