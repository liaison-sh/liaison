// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { FIRST_LAUNCH_UNREACHABLE } from "./mobile-copy"
import {
  applyBranding,
  BRANDING_PATH,
  createFirstLaunch,
  FIRST_LAUNCH_ID,
  fetchRuntimeBranding,
  isValidServerAddress,
  normalizeServerAddress,
  parseConnectLink,
  SERVER_ADDRESS_KEY,
} from "./server-address"

const BRANDING = { orgName: "Acme", logoUrl: null, flags: {}, byokModelIds: [] }

/** The prompt is rendered after the stored address is read, which is async. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeFetch(status: number, body: unknown) {
  const calls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return { impl, calls }
}

function memoryStorage(initial: string | null = null) {
  let stored = initial
  const state = {
    writes: 0,
    get: async (key: string) => {
      expect(key).toBe(SERVER_ADDRESS_KEY)
      return stored
    },
    set: async (key: string, value: string) => {
      expect(key).toBe(SERVER_ADDRESS_KEY)
      state.writes += 1
      stored = value
    },
    read: () => stored,
  }
  return state
}

beforeEach(() => {
  document.body.innerHTML = ""
})
afterEach(() => {
  document.body.innerHTML = ""
})

describe("fetchRuntimeBranding", () => {
  it("calls the server the user named, not a baked in URL", async () => {
    const fetcher = fakeFetch(200, { data: BRANDING })
    await fetchRuntimeBranding("https://acme.example.com/", fetcher.impl)
    expect(fetcher.calls[0]).toBe(`https://acme.example.com${BRANDING_PATH}`)
  })

  it("rejects a failure rather than rendering a deployment called nothing", async () => {
    const failing = fakeFetch(500, { error: "boom" })
    await expect(fetchRuntimeBranding("https://acme.example.com", failing.impl)).rejects.toThrow(
      "500",
    )
    const wrongShape = fakeFetch(200, { data: { orgName: 42 } })
    await expect(
      fetchRuntimeBranding("https://acme.example.com", wrongShape.impl),
    ).rejects.toThrow()
  })
})

describe("what a person types as a server address", () => {
  it("a bare host gets https:// and is then valid", () => {
    expect(normalizeServerAddress("  liaison.example.com  ")).toBe("https://liaison.example.com")
    expect(isValidServerAddress(normalizeServerAddress("liaison.example.com"))).toBe(true)
  })
  it("keeps an explicit scheme and drops a trailing slash", () => {
    expect(normalizeServerAddress("http://192.168.1.10:3000/")).toBe("http://192.168.1.10:3000")
    expect(normalizeServerAddress("https://acme.example.com")).toBe("https://acme.example.com")
  })
  it("leaves empty input empty, so it is still refused", () => {
    expect(isValidServerAddress(normalizeServerAddress("   "))).toBe(false)
  })
})

describe("server address validation", () => {
  it("takes http and https addresses only", () => {
    expect(isValidServerAddress("https://acme.example.com")).toBe(true)
    expect(isValidServerAddress("http://192.168.1.10:3000")).toBe(true)
    for (const bad of ["", "acme.example.com", "javascript:alert(1)", "file:///etc/passwd"]) {
      expect(isValidServerAddress(bad)).toBe(false)
    }
  })

  it("reads a bare domain as https and leaves any typed scheme alone", () => {
    expect(normalizeServerAddress(" acme.example.com ")).toBe("https://acme.example.com")
    expect(normalizeServerAddress("localhost:3000")).toBe("https://localhost:3000")
    expect(normalizeServerAddress("http://192.168.1.10:3000")).toBe("http://192.168.1.10:3000")
    expect(isValidServerAddress(normalizeServerAddress("javascript:alert(1)"))).toBe(false)
    expect(isValidServerAddress(normalizeServerAddress("file:///etc/passwd"))).toBe(false)
    expect(normalizeServerAddress("")).toBe("")
  })

  it("reads the server out of a connect deep link, fail closed", () => {
    expect(parseConnectLink("liaison://connect?server=https://acme.example.com")).toBe(
      "https://acme.example.com",
    )
    for (const bad of [
      "liaison://connect",
      "liaison://connect?server=javascript:alert(1)",
      "liaison://connect?server=https://acme.example.com&next=/x",
      "liaison://thread/abc123",
      "https://example.com/connect?server=https://acme.example.com",
    ]) {
      expect(parseConnectLink(bad)).toBeNull()
    }
  })
})

describe("first launch", () => {
  it("reads the bound address out of storage, with no call to that server", async () => {
    // THE BINDING IS WHAT STORAGE SAYS. The branding fetch validates it, and
    // the boot sequence cannot wait on a validation to learn where the
    // refresh token may be presented: offline, that wait never ends (main.ts).
    const storage = memoryStorage("https://acme.example.com")
    const fetcher = fakeFetch(200, { data: BRANDING })
    const launch = createFirstLaunch({ storage, document, fetchImpl: fetcher.impl })
    expect(await launch.boundAddress()).toBe("https://acme.example.com")
    expect(fetcher.calls).toEqual([])
  })

  it("is bound to nothing when what is stored is not an address", async () => {
    const storage = memoryStorage("javascript:alert(1)")
    const fetcher = fakeFetch(200, { data: BRANDING })
    const launch = createFirstLaunch({ storage, document, fetchImpl: fetcher.impl })
    expect(await launch.boundAddress()).toBeNull()
  })

  it("gives up on a branding request that never answers", async () => {
    // A host that accepts the connection and says nothing left the overlay on
    // screen for the life of the page, with no way to correct the address.
    let aborted = false
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true
      })
      return new Promise<Response>(() => {})
    }) as typeof fetch
    await expect(fetchRuntimeBranding("https://acme.example.com", hanging, 10)).rejects.toThrow()
    expect(aborted).toBe(true)
  })

  it("prompts when nothing is stored, and persists what was entered", async () => {
    const storage = memoryStorage(null)
    const fetcher = fakeFetch(200, { data: BRANDING })
    const launch = createFirstLaunch({
      storage,
      document,
      fetchImpl: fetcher.impl,
    })
    const started = launch.start()
    await tick()
    const input = document.querySelector("input") as HTMLInputElement
    expect(input).toBeTruthy()
    input.value = "https://acme.example.com"
    ;(document.querySelector("button") as HTMLButtonElement).click()
    expect(await started).toBe("https://acme.example.com")
    expect(storage.read()).toBe("https://acme.example.com")
  })

  it("takes the bare domain the placeholder shows, as https", async () => {
    const storage = memoryStorage(null)
    const fetcher = fakeFetch(200, { data: BRANDING })
    const launch = createFirstLaunch({ storage, document, fetchImpl: fetcher.impl })
    const started = launch.start()
    await tick()
    const input = document.querySelector("input") as HTMLInputElement
    expect(input.placeholder).toBe("liaison.example.com")
    input.value = "acme.example.com"
    ;(document.querySelector("button") as HTMLButtonElement).click()
    expect(await started).toBe("https://acme.example.com")
  })

  it("refuses an invalid address in place instead of storing it", async () => {
    const storage = memoryStorage(null)
    const fetcher = fakeFetch(200, { data: BRANDING })
    const launch = createFirstLaunch({ storage, document, fetchImpl: fetcher.impl })
    const started = launch.start()
    await tick()
    const input = document.querySelector("input") as HTMLInputElement
    input.value = "not an address"
    ;(document.querySelector("button") as HTMLButtonElement).click()
    expect(document.querySelector('[role="alert"]')?.textContent ?? "").not.toBe("")
    expect(storage.read()).toBeNull()
    // Still usable: a correction goes through.
    input.value = "https://acme.example.com"
    ;(document.querySelector("button") as HTMLButtonElement).click()
    expect(await started).toBe("https://acme.example.com")
  })

  it("never applies a deep link address on its own", async () => {
    const storage = memoryStorage(null)
    const fetcher = fakeFetch(200, { data: BRANDING })
    const launch = createFirstLaunch({ storage, document, fetchImpl: fetcher.impl })
    const started = launch.start()
    await tick()
    launch.offerAddress("https://attacker.example.com")
    // Shown, prefilled, and waiting for a click. Nothing stored.
    const input = document.querySelector("input") as HTMLInputElement
    expect(input.value).toBe("https://attacker.example.com")
    expect(storage.read()).toBeNull()
    ;(document.querySelector("button") as HTMLButtonElement).click()
    expect(await started).toBe("https://attacker.example.com")
    expect(storage.read()).toBe("https://attacker.example.com")
  })

  // The address is only good if the server it names ANSWERS. Persisting it
  // before the branding fetch stored an address the app could never use, and
  // since the prompt had already resolved it never came back: the install was
  // pointed at nothing, permanently.
  it("does not store an address whose server cannot be reached, and asks again", async () => {
    const storage = memoryStorage(null)
    let reachable = false
    const fetchImpl = (async () => {
      if (!reachable) throw new TypeError("network refused")
      return new Response(JSON.stringify({ data: BRANDING }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    const launch = createFirstLaunch({ storage, document, fetchImpl })
    const started = launch.start()
    await tick()
    const input = document.querySelector("input") as HTMLInputElement
    input.value = "https://unreachable.example.com"
    ;(document.querySelector("button") as HTMLButtonElement).click()
    await tick()

    expect(storage.read()).toBeNull()
    expect(document.getElementById(FIRST_LAUNCH_ID)).toBeTruthy()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(FIRST_LAUNCH_UNREACHABLE)

    // Re-entering is how a wrong address is cleared: the second try answers.
    reachable = true
    const retry = document.querySelector("input") as HTMLInputElement
    retry.value = "https://acme.example.com"
    ;(document.querySelector("button") as HTMLButtonElement).click()
    expect(await started).toBe("https://acme.example.com")
    expect(storage.read()).toBe("https://acme.example.com")
  })

  it("persists a reachable address exactly once", async () => {
    const storage = memoryStorage(null)
    const fetcher = fakeFetch(200, { data: BRANDING })
    const launch = createFirstLaunch({ storage, document, fetchImpl: fetcher.impl })
    const started = launch.start()
    await tick()
    const input = document.querySelector("input") as HTMLInputElement
    input.value = "https://acme.example.com"
    ;(document.querySelector("button") as HTMLButtonElement).click()
    expect(await started).toBe("https://acme.example.com")
    expect(storage.writes).toBe(1)
    expect(storage.read()).toBe("https://acme.example.com")
  })

  it("uses the stored address with no prompt on a later launch", async () => {
    const storage = memoryStorage("https://saved.example.com")
    const fetcher = fakeFetch(200, { data: BRANDING })
    const launch = createFirstLaunch({ storage, document, fetchImpl: fetcher.impl })
    expect(await launch.start()).toBe("https://saved.example.com")
    expect(document.querySelector("input")).toBeNull()
    expect(fetcher.calls[0]).toBe(`https://saved.example.com${BRANDING_PATH}`)
  })
})

describe("the address field never zooms the page", () => {
  it("is at least 16px, the size under which iOS zooms on focus", async () => {
    const storage = memoryStorage(null)
    const fetcher = fakeFetch(200, { data: BRANDING })
    createFirstLaunch({ storage, document, fetchImpl: fetcher.impl }).start()
    await tick()
    const input = document.querySelector("input") as HTMLInputElement
    expect(input).toBeTruthy()
    expect(Number.parseFloat(input.style.fontSize)).toBeGreaterThanOrEqual(16)
  })
})

describe("the prompt survives the app it precedes", () => {
  it("sits above the wrapped app and outlives a body re-render", async () => {
    // Measured on a booted simulator: appended to <body> with no styles, the
    // prompt was simply not on screen. The wrapped SolidJS app mounts into the
    // same body straight after this script runs and owns the viewport, so the
    // prompt has to be a top layer overlay on documentElement, exactly as the
    // desktop shell's overlay is.
    const storage = memoryStorage(null)
    const fetcher = fakeFetch(200, { data: BRANDING })
    createFirstLaunch({ storage, document, fetchImpl: fetcher.impl }).start()
    await tick()
    const overlay = document.querySelector(`#${FIRST_LAUNCH_ID}`) as HTMLElement
    expect(overlay).toBeTruthy()
    expect(overlay.parentElement).toBe(document.documentElement)
    expect(overlay.style.position).toBe("fixed")
    expect(overlay.style.inset).toBe("0")
    expect(Number(overlay.style.zIndex)).toBeGreaterThan(1_000_000)

    // The app mounting, which is what wiped it before.
    document.body.innerHTML = '<div id="root">the wrapped app</div>'
    expect(document.querySelector(`#${FIRST_LAUNCH_ID}`)).toBe(overlay)
  })
})

describe("runtime branding", () => {
  it("swapping the server branding response changes the title with no rebuild, and adds nothing visible", () => {
    document.body.innerHTML = '<div id="root">the wrapped app</div>'
    applyBranding(document, { ...BRANDING, orgName: "Acme" })
    const first = document.title
    applyBranding(document, { ...BRANDING, orgName: "Umbrella", logoUrl: "/logo.svg" })
    expect(first).toBe("Acme")
    expect(document.title).toBe("Umbrella")
    // Nothing is appended under the app: the org name used to sit below the tab bar.
    expect(document.body.textContent).toBe("the wrapped app")
    expect(document.querySelector("#liaison-boot-brand")).toBeNull()
  })

  it("no fork specific branding literal is compiled into the built web assets", () => {
    // One build runs against every fork, so the deployment's own name must not
    // be a string in the bundle. The trees scanned are the ones cap sync
    // produces plus apps/web's own build; a checkout with none of them built
    // fails here rather than passing on nothing.
    const roots = [
      path.resolve(import.meta.dir, "../../ios/App/App/public"),
      path.resolve(import.meta.dir, "../../android/app/src/main/assets/public"),
      path.resolve(import.meta.dir, "../../../web/dist"),
      path.resolve(import.meta.dir, "../../../web/dist-native"),
    ].filter((dir) => existsSync(dir))
    expect(roots.length).toBeGreaterThan(0)

    // Hint strings use the reserved example domains, which name no deployment.
    // A real deployment's name or domain is caught before publication by the
    // source scan over every file, so this bundle-level check only needs the
    // fictitious stand-ins the fixtures use.
    const KNOWN: string[] = []
    const FORK_LITERALS = [/\bFabrikam\b/, /fabrikam\.example/, /tailspin\.example/]

    const offenders: string[] = []
    for (const root of roots) {
      const stack = [root]
      while (stack.length > 0) {
        const current = stack.pop() as string
        for (const entry of readdirSync(current)) {
          const full = path.join(current, entry)
          if (statSync(full).isDirectory()) {
            stack.push(full)
            continue
          }
          if (!/\.(?:js|css|html|json)$/.test(entry)) continue
          let text = readFileSync(full, "utf8")
          for (const known of KNOWN) text = text.split(known).join("")
          for (const literal of FORK_LITERALS) {
            if (literal.test(text)) offenders.push(`${path.relative(root, full)}: ${literal}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
