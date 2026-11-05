// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A request started inside an effect must not make that effect depend on the
// pause signals: settling it would re-run the effect, which requests again.
import { createEffect, createRoot } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import {
  noteServerBack,
  noteServerRestarting,
  ServerPauseTestAccess,
  trackRequest,
} from "~/lib/server-pause"

afterEach(() => ServerPauseTestAccess.reset())

describe("server-pause writers never subscribe the caller", () => {
  it("an effect that starts a request runs once, however the request settles", async () => {
    let runs = 0
    const settles: Array<() => void> = []
    const dispose = createRoot((d) => {
      createEffect(() => {
        runs++
        settles.push(trackRequest())
        noteServerRestarting()
        noteServerBack()
      })
      return d
    })
    await Promise.resolve()
    expect(runs).toBe(1)
    for (const settle of settles.splice(0)) settle()
    noteServerRestarting()
    noteServerBack()
    await Promise.resolve()
    expect(runs).toBe(1)
    dispose()
  })
})
