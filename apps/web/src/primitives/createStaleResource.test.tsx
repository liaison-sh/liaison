// SPDX-License-Identifier: FSL-1.1-ALv2
import { render } from "@solidjs/testing-library"
import { type Accessor, createSignal, type JSX } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { requestResync } from "~/framework/resync"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import { createStaleResource, STALE_AFTER_MS, type StaleResource } from "./createStaleResource"

afterEach(() => {
  vi.restoreAllMocks()
})

// Flush microtasks so createResource's async fetcher settles.
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/**
 * Mount the primitive inside a real Solid render tree under a
 * TabVisibilityProvider, handing the created resource back to the test.
 */
function mountStale<T>(
  fetcher: () => T | Promise<T>,
  active: Accessor<boolean> | undefined,
  opts?: { staleAfterMs?: number },
): { res: StaleResource<T>; unmount: () => void } {
  let res!: StaleResource<T>
  const Probe = (): JSX.Element => {
    res = createStaleResource<T>(fetcher, opts)
    return null
  }
  const { unmount } = render(() =>
    active ? (
      <TabVisibilityProvider value={active}>
        <Probe />
      </TabVisibilityProvider>
    ) : (
      <Probe />
    ),
  )
  return { res, unmount }
}

describe("createStaleResource", () => {
  it("initial mount fetches exactly once (no effect-driven double fetch)", async () => {
    const fetcher = vi.fn().mockResolvedValue("v1")
    const { unmount } = mountStale(fetcher, () => true)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    unmount()
  })

  it("resync bump while active triggers exactly one refetch and shows new data", async () => {
    let call = 0
    const fetcher = vi.fn().mockImplementation(async () => `v${++call}`)
    const { res, unmount } = mountStale<string>(fetcher, () => true)
    await flush()
    expect(res()).toBe("v1")
    expect(fetcher).toHaveBeenCalledTimes(1)

    requestResync("test")
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(res()).toBe("v2")
    unmount()
  })

  it("boundary: elapsed exactly staleAfterMs on activation does NOT refetch (strict >)", async () => {
    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    const [active, setActive] = createActiveSignal(false)
    const fetcher = vi.fn().mockResolvedValue("v1")
    const { unmount } = mountStale(fetcher, active)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Advance to EXACTLY the threshold, then activate -> no refetch.
    now += STALE_AFTER_MS
    setActive(true)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)

    // One more ms past threshold and re-activation -> refetch.
    setActive(false)
    await flush()
    now += 1
    setActive(true)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    unmount()
    nowSpy.mockRestore()
  })

  it("second bump while first refetch in flight observes the version at its dispatch", async () => {
    const resolvers: Array<(v: string) => void> = []
    const fetcher = vi.fn().mockImplementation(() => new Promise<string>((r) => resolvers.push(r)))
    const { unmount } = mountStale<string>(fetcher, () => true)
    await flush()
    resolvers[0]?.("v1")
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)

    requestResync("first")
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    // Second bump while first refetch still in flight -> a second refetch.
    requestResync("second")
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(3)
    unmount()
  })

  it("bump while tab inactive still fires (resync is unconditional)", async () => {
    const [active] = createActiveSignal(false)
    const fetcher = vi.fn().mockResolvedValue("v1")
    const { unmount } = mountStale(fetcher, active)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)

    requestResync("while-inactive")
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    unmount()
  })

  it("activation with fresh data (< staleAfterMs) does not refetch", async () => {
    let now = 2_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    const [active, setActive] = createActiveSignal(false)
    const fetcher = vi.fn().mockResolvedValue("v1")
    const { unmount } = mountStale(fetcher, active)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)

    now += STALE_AFTER_MS - 1
    setActive(true)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    unmount()
    nowSpy.mockRestore()
  })

  it("refetch failure retains previous data and surfaces error", async () => {
    let call = 0
    const fetcher = vi.fn().mockImplementation(async () => {
      call++
      if (call === 2) throw new Error("boom")
      return `v${call}`
    })
    const { res, unmount } = mountStale<string>(fetcher, () => true)
    await flush()
    expect(res()).toBe("v1")

    requestResync("fail")
    await flush()
    // Previous value retained despite error.
    expect(res()).toBe("v1")
    expect(res.error).toBeInstanceOf(Error)
    unmount()
  })

  it("first-load failure propagates (no last-good value to fall back to)", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("first load boom"))
    const { res, unmount } = mountStale<string>(fetcher, () => true)
    await flush()
    // No prior successful fetch, so the accessor must re-throw instead of
    // silently swallowing the error into `undefined` — otherwise
    // <ErrorBoundary> never fires on a first-load failure.
    expect(() => res()).toThrow("first load boom")
    expect(res.error).toBeInstanceOf(Error)
    unmount()
  })

  it("refetch failure after a successful first load keeps returning last-good (no throw)", async () => {
    let call = 0
    const fetcher = vi.fn().mockImplementation(async () => {
      call++
      if (call === 2) throw new Error("refetch boom")
      return `v${call}`
    })
    const { res, unmount } = mountStale<string>(fetcher, () => true)
    await flush()
    expect(res()).toBe("v1")

    requestResync("refetch-fail")
    await flush()
    // A last-good value exists (v1), so the accessor must NOT throw — it
    // keeps surfacing the prior value while `.error` reports the failure.
    expect(() => res()).not.toThrow()
    expect(res()).toBe("v1")
    expect(res.error).toBeInstanceOf(Error)
    unmount()
  })

  it("outside a TabVisibilityProvider behaves as always-active", async () => {
    let call = 0
    const fetcher = vi.fn().mockImplementation(async () => `v${++call}`)
    const { res, unmount } = mountStale<string>(fetcher, undefined)
    await flush()
    expect(res()).toBe("v1")

    requestResync("no-provider")
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    unmount()
  })
})

function createActiveSignal(initial: boolean): [Accessor<boolean>, (v: boolean) => void] {
  const [a, set] = createSignal(initial)
  return [a, (v: boolean) => set(v)]
}
