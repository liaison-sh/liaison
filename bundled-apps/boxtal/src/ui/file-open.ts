// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Opening a kernel file in a new tab, the only way that actually works in this app.
//
// Two rules, both learned from a real "cannot retrieve the label" bug:
//
// 1. A bare `window.open(url)` carries NO credentials, and the kernel file route is bearer
//    authenticated. So the bytes are fetched with the in-memory access token and handed to the tab
//    as a blob URL.
// 2. The tab MUST be opened synchronously inside the click handler. Opening it after the tool call
//    and the fetch have been awaited is outside the user gesture, so the browser's popup blocker
//    swallows it silently. Every caller therefore does `const win = openPreparingTab()` FIRST, then
//    awaits, then `loadFileInto(fileId, win)`.
//
// Under the desktop shell neither works: its webview opens no tab and refuses `blob:` links, so the
// button did nothing. There the host opens the file itself (`openFile`: the shell saves the bytes
// and opens them in the default PDF viewer) and the pre-opened tab, if any, is closed.
//
// In a frame (the screen on its own origin, or a shell's frame) the app has no network and no
// popup: it names the file and the HOST fetches and opens it (`app.openFile`), so no tab is
// pre-opened there.
//
// Shared by ReadyToShip (print pack) and PrepGrid (invoice download, label).

import { app, fetchBlob, openFile } from "@liaison/host"

/** Pre-open a tab inside the click gesture (popup safe) with a placeholder, so the operator sees
 *  "preparing" rather than a bare about:blank while the tool call runs. */
export function openPreparingTab(): Window | null {
  // The host opens the file itself (framed): no tab of the app's.
  if (app.opensFiles()) return null
  const win = window.open("", "_blank")
  try {
    win?.document.write(
      '<title>Preparing document</title><body style="font-family:system-ui;color:#666;padding:2rem">Preparing document, this tab will load it shortly...</body>',
    )
  } catch {
    // Cross-origin/document quirks: the placeholder is cosmetic, never fatal.
  }
  return win
}

/** Fetch a kernel file's bytes with the bearer token and load them into a PRE-OPENED tab, or hand
 *  them to the host when it opens files itself (desktop). One call per document: the label and the
 *  invoice each get their own tab. `baseName` names the file the desktop saves ("label", "invoice"). */
export async function loadFileInto(fileId: string, win: Window | null, baseName = "document"): Promise<void> {
  // Framed: the host fetches and shows it; no bytes reach this screen.
  if (await app.openFile(fileId, `${baseName}-${fileId.slice(0, 8)}.pdf`)) {
    win?.close()
    return
  }
  // Through the host (bound server + bearer): a page-relative fetch lands on
  // the desktop or mobile shell's own index.html, a web page labelled PDF.
  let blob: Blob
  try {
    blob = await fetchBlob(`/api/files/${fileId}/inline`)
  } catch (e) {
    win?.close()
    throw e
  }
  const pdfBlob = blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" })
  let openedNatively: boolean
  try {
    openedNatively = await openFile(pdfBlob, `${baseName}-${fileId.slice(0, 8)}.pdf`)
  } catch (e) {
    win?.close()
    throw e
  }
  if (openedNatively) {
    win?.close()
    return
  }
  const url = URL.createObjectURL(pdfBlob)
  if (win) win.location.href = url
  else window.open(url, "_blank", "noopener")
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
