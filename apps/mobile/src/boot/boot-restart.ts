// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE BOOT RESTART GOES BACK TO WHERE THE PAGE STARTED.
//
// The shell restarts the page during boot when the app started without
// knowing its server (no address mirror, a mirror that disagreed with
// Preferences, or page storage that belonged to another server: main.ts and
// servers/server-list.ts). Until that restart the app ran UNBOUND: no server,
// so no session to restore, and ProtectedRoute had already sent it to
// /login?returnTo=... by the time the shell knew better. A plain
// `location.reload()` kept that route. After the restart the session restored
// fine, but the login surface never takes a user off /login unless the shell
// itself bounced them there (Login.tsx, FX11), so the user sat on the sign-in
// card with a live session until the next launch.
//
// So the route the page was started on is captured when the boot bundle is
// evaluated, before the app's own modules run, and the restart replaces the
// page with it. Whatever the unbound app decided about routes is discarded
// with the rest of its state.

/** Just enough of `window.location`. */
export interface RestartableLocation {
  pathname: string
  search: string
  hash: string
  reload: () => void
  replace: (url: string) => void
}

/** Call at boot-bundle evaluation; the returned function restarts the page there. */
export function createBootRestart(location: RestartableLocation): () => void {
  const startPath = `${location.pathname}${location.search}${location.hash}`
  return () => {
    // Unmoved, a reload is the restart: a replace to the same URL with a
    // fragment is a fragment navigation and would not restart anything.
    if (`${location.pathname}${location.search}${location.hash}` === startPath) location.reload()
    else location.replace(startPath)
  }
}
