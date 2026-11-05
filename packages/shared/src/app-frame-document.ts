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

/** The frame's policy, less what a meta element cannot carry (`frame-ancestors`). */
export function appFramePolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' blob:`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
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
export function appFrameDocument(runtime: string, nonce: string): string {
  // `</script` inside the runtime would end the element early.
  const safe = runtime.replace(/<\/script/gi, "<\\/script")
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8" />',
    `<meta http-equiv="Content-Security-Policy" content="${appFramePolicy(nonce)}" />`,
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
