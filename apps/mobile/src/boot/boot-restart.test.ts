// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createBootRestart, type RestartableLocation } from "./boot-restart"

/** A location whose route the app can move, as the router does. */
function fakeLocation(start: string): RestartableLocation & { loads: string[] } {
  const url = new URL(start, "capacitor://localhost")
  const loc = {
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    loads: [] as string[],
    reload() {
      loc.loads.push(loc.pathname + loc.search + loc.hash)
    },
    replace(next: string) {
      loc.loads.push(next)
    },
  }
  return loc
}

describe("the boot restart", () => {
  it("starts the page again where it started, not on the /login the unbound page bounced to", () => {
    // A launch with no address mirror boots the app unbound: it has no session
    // to restore, so ProtectedRoute sends it to /login. The shell then restarts
    // the page against the bound server, where the session restores, but the
    // login surface never leaves a route the user is on, so the user sat on
    // the sign-in card holding a live session until the next launch.
    const loc = fakeLocation("/")
    const restart = createBootRestart(loc)
    loc.pathname = "/login"
    loc.search = "?returnTo=%2F"
    restart()
    expect(loc.loads).toEqual(["/"])
  })

  it("keeps a deep path and query the page was started on", () => {
    const loc = fakeLocation("/threads/abc?x=1#m")
    const restart = createBootRestart(loc)
    loc.pathname = "/login"
    loc.search = "?returnTo=%2Fthreads%2Fabc"
    loc.hash = ""
    restart()
    expect(loc.loads).toEqual(["/threads/abc?x=1#m"])
  })

  it("reloads when the route has not moved (a same-URL replace with a fragment restarts nothing)", () => {
    const loc = fakeLocation("/inbox#top")
    let reloaded = 0
    let replaced = 0
    loc.reload = () => {
      reloaded++
    }
    loc.replace = () => {
      replaced++
    }
    createBootRestart(loc)()
    expect([reloaded, replaced]).toEqual([1, 0])
  })
})
