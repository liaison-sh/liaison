// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell is injected into a page it does not own (apps/web, unmodified).
// Since A33 it draws NOTHING there: the first thing that must hold is that it
// appends no element and renders no DOM, and the second is that the wiring the
// page cannot do for itself is all still armed: the server address global, the
// bridge, the refresh bridge, the diagnostics, the probe, the shell's events
// and the teardown that releases the thread claim when the window goes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The shell's event subscription is made once per module, so the handlers are
// recorded in a registry the per-test `mockClear` does not empty.
const { invoke, listen, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>()
  return {
    handlers,
    invoke: vi.fn(
      async (_command: string, _args?: Record<string, unknown>) => undefined as unknown,
    ),
    listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
      const existing = handlers.get(event) ?? []
      existing.push(handler)
      handlers.set(event, existing)
      return () => undefined
    }),
  }
})
vi.mock("./tauri", () => ({ invoke, listen }))

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DESKTOP_BRIDGE_EVENT,
  DESKTOP_BRIDGE_KEY,
  DESKTOP_BRIDGE_VERSION,
} from "@liaison/web/lib/desktop-shell-contract"
import { publishDesktopBridge, resetDesktopBridge } from "./bridge"
import {
  bootOverlay,
  installRefreshBridge,
  mountOverlay,
  mountServerGlobal,
  resetOverlayWiring,
} from "./overlay"
import {
  loadServerAddress,
  noteServerAddress,
  RUNTIME_LOCATION_MIRROR_KEY,
  resetDesktopStore,
} from "./session/desktop-store"
import { SERVER_ADDRESS_GLOBAL, SERVER_ADDRESS_MIRROR_KEY } from "./session/server-global"

function shellAnswers(address: string | null): void {
  invoke.mockImplementation(async (command: string) => {
    if (command === "get_server_address") return address
    if (command === "platform_info") return { os: "macos", arch: "aarch64" }
    return undefined
  })
}

describe("the shell in the page", () => {
  beforeEach(() => {
    localStorage.clear()
    resetDesktopStore()
    resetDesktopBridge()
    resetOverlayWiring()
    document.body.innerHTML = ""
    invoke.mockClear()
    listen.mockClear()
    shellAnswers(null)
    delete (globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]
    delete (globalThis as Record<string, unknown>).__liaisonRefreshBridge__
    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 500 }),
    ) as unknown as typeof fetch
  })
  afterEach(() => {
    resetOverlayWiring()
    resetDesktopStore()
    vi.unstubAllGlobals()
    delete (globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]
  })

  // THE WHOLE POINT OF A33. The page renders every pixel of a local session in
  // its own components; a shell that appended a root of its own would be the
  // second type scale, the floating control and the panel over the page all
  // over again.
  it("the overlay creates no root element and renders no DOM", () => {
    const page = document.createElement("div")
    page.id = "app"
    document.body.append(page)
    const before = document.body.children.length

    mountOverlay(document)

    expect(document.body.children.length).toBe(before)
    expect(document.getElementById("liaison-desktop-root")).toBeNull()
    expect(document.querySelector("[data-testid^='liaison-desktop']")).toBeNull()
    expect(page.children.length).toBe(0)
  })

  it("the overlay still publishes the server address global and the bridge", async () => {
    shellAnswers("https://liaison.test/")
    const target = globalThis as Record<string, unknown>

    mountOverlay(document)

    expect(DESKTOP_BRIDGE_KEY in target).toBe(true)
    await vi.waitFor(() => expect(target[SERVER_ADDRESS_GLOBAL]).toBe("https://liaison.test"))
  })

  it("publishes nothing while the shell has no address", async () => {
    mountOverlay(document)
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([command]) => command === "get_server_address")).toBe(true),
    )
    expect(SERVER_ADDRESS_GLOBAL in (globalThis as Record<string, unknown>)).toBe(false)
  })

  it("arms the shell's own event streams, so a device grant is never missed", async () => {
    mountOverlay(document)
    await vi.waitFor(() => expect(handlers.has("liaison-device-approval")).toBe(true))
    expect(handlers.has("liaison-reconnect-required")).toBe(true)
  })

  // THE PAGE HAS TO START AGAIN. apps/web resolves its API base while its own
  // modules load, so a page that came up with no address has already built its
  // session against `tauri://localhost`, which serves no API: the login says
  // it cannot reach the server and nothing ever retries. Binding an address
  // publishes the global and reloads, once (session/server-global.ts).
  it("reloads the page once when the login card binds an address", async () => {
    const reload = vi.fn()
    invoke.mockImplementation(async (command: string) => {
      if (command === "get_server_address") return null
      if (command === "platform_info") return { os: "macos", arch: "aarch64" }
      return undefined
    })
    mountOverlay(document, { reload })
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([command]) => command === "get_server_address")).toBe(true),
    )

    noteServerAddress("http://localhost:3100")

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect((globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]).toBe(
      "http://localhost:3100",
    )
  })

  it("does not reload when the page already booted on the shell's address", async () => {
    const reload = vi.fn()
    localStorage.setItem(SERVER_ADDRESS_MIRROR_KEY, "https://liaison.test")
    shellAnswers("https://liaison.test")
    mountServerGlobal()

    mountOverlay(document, { reload })

    await vi.waitFor(() =>
      expect((globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]).toBe(
        "https://liaison.test",
      ),
    )
    expect(reload).not.toHaveBeenCalled()
  })

  it("asks the shell for the address exactly once, however many times it is evaluated", async () => {
    shellAnswers("https://liaison.test")
    await loadServerAddress()
    invoke.mockClear()

    mountOverlay(document)
    mountOverlay(document)

    // Long enough for a second bootstrap to have reached the shell, had one
    // been started.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(invoke.mock.calls.filter(([command]) => command === "get_server_address")).toHaveLength(
      0,
    )
  })

  // A WINDOW CLOSING IS A SESSION ENDING. A claim nobody releases leaves the
  // conversation with no answerer at all until its TTL runs out.
  // P6d-FX3, W1. THE INJECTED SCRIPT RUNS BEFORE THE DOCUMENT HAS A BODY, which
  // is what an initialization script is for, and it used to defer the whole
  // wiring to `DOMContentLoaded` when it found none. That event fires AFTER the
  // page's own modules have evaluated, so apps/web resolved the bridge, found
  // nothing, and rendered no desktop surface for the life of the window. The
  // bridge is published in the same tick the bundle is evaluated, body or no
  // body, and nothing is waited for.
  it("publishes the bridge before the document has a body, waiting on no event", () => {
    const listened: string[] = []
    const view = {
      addEventListener: (type: string) => {
        listened.push(type)
      },
      removeEventListener: () => undefined,
      console: { error: () => undefined },
    } as unknown as Window & Record<string, unknown>
    const loading = {
      body: null,
      readyState: "loading",
      defaultView: view,
      addEventListener: (type: string) => {
        listened.push(type)
      },
      removeEventListener: () => undefined,
      querySelector: () => null,
    } as unknown as Document

    bootOverlay(loading)

    expect(DESKTOP_BRIDGE_KEY in (view as Record<string, unknown>)).toBe(true)
    expect(listened).not.toContain("DOMContentLoaded")
  })

  // The other half of W1: a page that had ALREADY looked and found nothing is
  // told. The shell fires it on the window it published onto; apps/web's store
  // listens for it and resolves again.
  it("announces the publication on the window it published onto", () => {
    const heard: string[] = []
    window.addEventListener(DESKTOP_BRIDGE_EVENT, () => heard.push("bridge"))

    mountOverlay(document)

    expect(heard).toEqual(["bridge"])
  })

  it("ends the session when the window goes away, on both of the events that fire", () => {
    mountOverlay(document)
    for (const name of ["pagehide", "beforeunload"]) {
      expect(() => globalThis.dispatchEvent(new Event(name))).not.toThrow()
    }
  })
})

// A33 again, from the source rather than from a render: the overlay's inline
// style module is gone, and nothing in what is left sets a style attribute or
// carries a style object. A component that crept back in would be drawn
// outside apps/web's tokens and outside its type scale, which is the defect
// this slice exists to remove.
describe("the desktop source", () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue
        out.push(...sourceFiles(full))
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
      out.push(full)
    }
    return out
  }

  it("no inline style attribute is set by apps/desktop source", () => {
    const root = join(import.meta.dirname)
    const offenders: string[] = []
    for (const file of sourceFiles(root)) {
      const body = readFileSync(file, "utf8")
      if (/\bstyle=/.test(body) || /\bapplyStyle\b/.test(body) || /\bsetProperty\(/.test(body)) {
        offenders.push(file.slice(root.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })
})

// The refresh header. From tauri://localhost the API's SameSite=Strict cookie
// is attached to nothing, so the token the server puts in the body has to be
// kept by the shell and presented back on the refresh call.
describe("the overlay's refresh bridge", () => {
  const SERVER = "https://box.example"

  beforeEach(() => {
    localStorage.clear()
    resetDesktopStore()
    invoke.mockClear()
    delete (globalThis as Record<string, unknown>).__liaisonRefreshBridge__
  })

  /** The page's own fetch, recorded, with the body the next call answers. */
  function fetchRecorder() {
    const calls: Array<{ url: string; header: string | null }> = []
    let body: Record<string, unknown> = { data: {} }
    let status = 200
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        header: new Headers(init?.headers).get("X-Liaison-Refresh"),
      })
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    return {
      calls,
      answerWith: (next: Record<string, unknown>) => {
        body = next
      },
      answerStatus: (next: number) => {
        status = next
      },
    }
  }

  /** The shell's 0600 store, behind the two commands the bridge calls. */
  function tokenStore(initial: string | null) {
    const state = { token: initial }
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "store_refresh_token") {
        state.token = (args?.token as string) || null
        return undefined
      }
      if (command === "load_refresh_token") return state.token
      return undefined
    })
    return state
  }

  /**
   * A RELOAD KEEPS THE SESSION.
   *
   * `location.reload()` in a signed-in desktop window came back to the login
   * card. The page resolves its API base from the global the injection script
   * publishes SYNCHRONOUSLY out of the mirror, so apps/web fires its first
   * `POST /api/auth/refresh` on that tick, while the shell's own
   * `serverAddress()` signal is still null (it is filled by an async
   * `get_server_address`). The bridge matched on that signal, so the origin it
   * was bound to was nothing, the stored refresh token was left off the call,
   * and this origin carries no refresh cookie: 401, and the window was signed
   * out. Full wiring, no shortcut through `installRefreshBridge`, because the
   * defect is in what `mountOverlay` binds the bridge TO.
   */
  it("presents the stored token on the reload's first refresh, before the shell has answered", async () => {
    resetOverlayWiring()
    resetDesktopBridge()
    localStorage.setItem(SERVER_ADDRESS_MIRROR_KEY, SERVER)
    const state = { token: "rt-from-a-previous-launch" as string | null }
    // The shell is SLOW: `get_server_address` never settles on this tick, which
    // is exactly the race a reload runs into.
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_server_address") return await new Promise(() => undefined)
      if (command === "load_refresh_token") return state.token
      if (command === "store_refresh_token") {
        state.token = (args?.token as string) || null
        return undefined
      }
      if (command === "platform_info") return { os: "macos", arch: "aarch64" }
      return undefined
    })

    const recorder = fetchRecorder()
    mountOverlay(document, { reload: () => undefined })

    recorder.answerWith({ data: { accessToken: "a", refreshToken: "rt-rotated" } })
    await globalThis.fetch(`${SERVER}/api/auth/refresh`, { method: "POST" })

    expect(recorder.calls[0].header).toBe("rt-from-a-previous-launch")
  })

  it("keeps the token a login handed back and presents it on the next refresh", async () => {
    let stored: string | null = null
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "store_refresh_token") {
        stored = (args?.token as string) || null
        return undefined
      }
      if (command === "load_refresh_token") return stored
      return undefined
    })

    const recorder = fetchRecorder()
    installRefreshBridge(() => SERVER)

    recorder.answerWith({ data: { accessToken: "a", refreshToken: "rt-one" } })
    await globalThis.fetch(`${SERVER}/api/auth/login`, { method: "POST" })
    await vi.waitFor(() => expect(stored).toBe("rt-one"))
    expect(recorder.calls[0].header).toBeNull()

    recorder.answerWith({ data: { accessToken: "b", refreshToken: "rt-two" } })
    await globalThis.fetch(`${SERVER}/api/auth/refresh`, { method: "POST" })
    expect(recorder.calls[1].header).toBe("rt-one")
    await vi.waitFor(() => expect(stored).toBe("rt-two"))
  })

  // SAVED BEFORE IT IS USED (A4). A rotation the shell could not keep is not
  // handed to the page: it keeps its old pair and reads a transient failure.
  it("keeps the old pair when the shell cannot save the rotated token", async () => {
    const state = { token: "rt-one" as string | null }
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "store_refresh_token") throw new Error("not the current server")
      if (command === "load_refresh_token") return state.token
      void args
      return undefined
    })
    const recorder = fetchRecorder()
    installRefreshBridge(() => SERVER)

    recorder.answerWith({ data: { accessToken: "new-access", refreshToken: "rt-two" } })
    const response = await globalThis.fetch(`${SERVER}/api/auth/refresh`, { method: "POST" })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { data?: unknown; error?: { code?: string } }
    expect(body.data).toBeUndefined()
    expect(body.error?.code).toBe("refresh_token_not_saved")
    expect(state.token).toBe("rt-one")
  })

  // ONE TOKEN CALL AT A TIME: two refreshes started together never present the
  // same stored token.
  it("queues concurrent refreshes so each presents the token the one before it saved", async () => {
    const state = tokenStore("rt-one")
    const presented: string[] = []
    let n = 0
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      presented.push(new Headers(init?.headers).get("X-Liaison-Refresh") ?? "")
      n += 1
      const minted = `rt-${n + 1}`
      await new Promise((resolve) => setTimeout(resolve, 5))
      return new Response(
        JSON.stringify({ data: { accessToken: `a${n}`, refreshToken: minted } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }) as unknown as typeof fetch
    installRefreshBridge(() => SERVER)

    await Promise.all([
      globalThis.fetch(`${SERVER}/api/auth/refresh`, { method: "POST" }),
      globalThis.fetch(`${SERVER}/api/auth/refresh`, { method: "POST" }),
    ])
    expect(presented).toEqual(["rt-one", "rt-2"])
    expect(state.token).toBe("rt-3")
  })

  /**
   * The API's rotation rule for a token presented in the header (apps/api
   * modules/auth refreshSession, routes.ts): a spent token under 30 s after its
   * successor was issued is a race, refused 401; after that a spent token whose
   * successor was used revokes the family. Nothing it did not mint is accepted.
   */
  function rotatingServer(initial: string) {
    let clock = 1_000_000
    let n = 0
    const rows = new Map<string, { successor: string | null; issuedAt: number }>([
      [initial, { successor: null, issuedAt: 0 }],
    ])
    const state = { revoked: false, presented: [] as Array<string | null> }
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    const respond = (input: RequestInfo | URL, init?: RequestInit): Response => {
      const path = new URL(String(input)).pathname
      const token = new Headers(init?.headers).get("X-Liaison-Refresh")
      if (path !== "/api/auth/refresh") return json(200, { data: {} })
      state.presented.push(token)
      const row = token === null ? undefined : rows.get(token)
      if (state.revoked || !row) return json(401, { error: { message: "Invalid session" } })
      if (row.successor !== null) {
        if (clock - row.issuedAt >= 30_000) state.revoked = true
        return json(401, { error: { message: "Invalid session" } })
      }
      n += 1
      const refreshToken = `rt-${n + 1}`
      rows.set(refreshToken, { successor: null, issuedAt: 0 })
      row.successor = refreshToken
      row.issuedAt = clock
      return json(200, { data: { accessToken: `access-${n + 1}`, refreshToken } })
    }
    return {
      state,
      respond,
      advance: (ms: number) => {
        clock += ms
      },
    }
  }

  // A FAILED SAVE DOES NOT SIGN THE USER OUT: the successor the shell could not
  // store is held in memory and presented next, never the spent token (which
  // inside 30 s the server refuses), and the save is tried again then.
  it("presents the unsaved successor on the next refresh and keeps the user signed in", async () => {
    const state = { token: "rt-1" as string | null, failures: 1 }
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "store_refresh_token") {
        if (state.failures > 0) {
          state.failures -= 1
          throw new Error("disk full")
        }
        state.token = (args?.token as string) || null
        return undefined
      }
      if (command === "load_refresh_token") return state.token
      return undefined
    })
    const server = rotatingServer("rt-1")
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      server.respond(input, init),
    ) as unknown as typeof fetch
    installRefreshBridge(() => SERVER)

    const first = await globalThis.fetch(`${SERVER}/api/auth/refresh`, { method: "POST" })
    expect(first.status).toBe(503)
    server.advance(5_000)
    const second = await globalThis.fetch(`${SERVER}/api/auth/refresh`, { method: "POST" })
    expect(second.status).toBe(200)
    expect(server.state.presented).toEqual(["rt-1", "rt-2"])
    expect(server.state.revoked).toBe(false)
    expect(state.token).toBe("rt-3")
  })

  // A refresh the page abandons (its timeout) has usually rotated already: the
  // call underneath runs to its end and its successor is kept.
  it("keeps the rotation of a refresh the page abandoned", async () => {
    const state = tokenStore("rt-1")
    const server = rotatingServer("rt-1")
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let stalled = true
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (stalled) {
        stalled = false
        await new Promise<void>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          void gate.then(resolve)
        })
      }
      return server.respond(input, init)
    }) as unknown as typeof fetch
    installRefreshBridge(() => SERVER)

    const controller = new AbortController()
    const abandoned = globalThis.fetch(`${SERVER}/api/auth/refresh`, {
      method: "POST",
      signal: controller.signal,
    })
    controller.abort()
    await expect(abandoned).rejects.toBeDefined()
    release()
    await vi.waitFor(() => expect(state.token).toBe("rt-2"))
    server.advance(5_000)
    const next = await globalThis.fetch(`${SERVER}/api/auth/refresh`, { method: "POST" })
    expect(next.status).toBe(200)
    expect(server.state.presented).toEqual(["rt-1", "rt-2"])
  })

  // A SIGN-OUT IS NEVER HELD HOSTAGE by a refresh that does not come back, and
  // a successor that arrives after it is not kept.
  it("signs out within its bound while a refresh is stalled, and keeps no late successor", async () => {
    const state = tokenStore("rt-one")
    let finishRefresh: (r: Response) => void = () => {}
    const sent: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      sent.push(path)
      if (path === "/api/auth/refresh") {
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve
        })
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch
    installRefreshBridge(() => SERVER, { logoutQueueWaitMs: 50 })

    const refresh = globalThis.fetch(`${SERVER}/api/auth/refresh`, { method: "POST" })
    const outcome = await Promise.race([
      globalThis.fetch(`${SERVER}/api/auth/logout`, { method: "POST" }).then(() => "signed out"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 1_000)),
    ])
    expect(outcome).toBe("signed out")
    expect(sent).toContain("/api/auth/logout")
    expect(state.token).toBeNull()
    finishRefresh(
      new Response(JSON.stringify({ data: { accessToken: "late", refreshToken: "rt-late" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    const late = await refresh
    expect(late.ok).toBe(false)
    expect(state.token).toBeNull()
  })

  // SIGNING OUT HAS TO REACH THE SERVER. apps/web posts an empty body and this
  // origin carries no cookie, so without the header the route had nothing to
  // revoke and the session row stayed valid for thirty days.
  it("presents the stored token on the logout call", async () => {
    tokenStore("rt-one")
    const recorder = fetchRecorder()
    installRefreshBridge(() => SERVER)

    await globalThis.fetch(`${SERVER}/api/auth/logout`, { method: "POST", body: "{}" })
    expect(recorder.calls[0].header).toBe("rt-one")
  })

  // A SIGN-OUT STICKS WHATEVER THE SERVER ANSWERED. A cold start under the
  // shell refreshes with whatever token the shell holds, so a token kept
  // after a failed logout signed the user back in at the next launch.
  it("forgets the token when the logout call fails on the server", async () => {
    const state = tokenStore("rt-one")
    const recorder = fetchRecorder()
    recorder.answerStatus(500)
    installRefreshBridge(() => SERVER)

    const response = await globalThis.fetch(`${SERVER}/api/auth/logout`, { method: "POST" })
    expect(response.status).toBe(500)
    expect(state.token).toBeNull()
  })

  it("forgets the token when the logout call never reaches the server", async () => {
    const state = tokenStore("rt-one")
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network down")
    }) as unknown as typeof fetch
    installRefreshBridge(() => SERVER)

    await expect(
      globalThis.fetch(`${SERVER}/api/auth/logout`, { method: "POST" }),
    ).rejects.toThrow()
    expect(state.token).toBeNull()
  })

  // The shell's half: the agent tokens, MCP config and device credentials it
  // keeps for the server go too, through its own `sign_out`, and only when the
  // page signed out of the shell's CURRENT server.
  it("runs the shell's sign-out for its current server, and not for another", async () => {
    const state = tokenStore("rt-one")
    const base = invoke.getMockImplementation()
    let current = SERVER
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_server_address") return current
      return base?.(command, args)
    })
    fetchRecorder()
    installRefreshBridge(() => SERVER)

    await globalThis.fetch(`${SERVER}/api/auth/logout`, { method: "POST" })
    expect(invoke).toHaveBeenCalledWith("sign_out")
    // Cleared first, so the shell has nothing to revoke a second time.
    expect(state.token).toBeNull()
    const order = invoke.mock.calls.map(([command]) => command)
    expect(order.indexOf("store_refresh_token")).toBeLessThan(order.indexOf("sign_out"))

    invoke.mockClear()
    current = "https://liaison.fabrikam.example"
    await globalThis.fetch(`${SERVER}/api/auth/logout`, { method: "POST" })
    expect(invoke).not.toHaveBeenCalledWith("sign_out")
  })

  it("clears the token when the server refuses it", async () => {
    const state = tokenStore("rt-one")
    const recorder = fetchRecorder()
    recorder.answerStatus(401)
    installRefreshBridge(() => SERVER)

    await globalThis.fetch(`${SERVER}/api/auth/logout`, { method: "POST" })
    await vi.waitFor(() => expect(state.token).toBeNull())
  })

  // SIGNING OUT HANDS THE RUNTIME BACK. The choice is this account's: it is
  // mirrored so a reload keeps it, and a window the next person signs in to is
  // THIS window. Clearing the mirror alone left the store and the signal on
  // "local", so the control offered them a machine that was not theirs while
  // every turn ran on Liaison.
  it("hands the runtime back to Liaison on logout, in the mirror and in the state", async () => {
    tokenStore("rt-one")
    const target: Record<string, unknown> = {}
    const bridge = publishDesktopBridge(target)
    expect(bridge.version).toBe(DESKTOP_BRIDGE_VERSION)
    bridge.setRuntimeLocation("local")
    expect(localStorage.getItem(RUNTIME_LOCATION_MIRROR_KEY)).toBe("local")
    const seen: string[] = []
    bridge.subscribe((next) => seen.push(next.runtimeLocation))

    const recorder = fetchRecorder()
    installRefreshBridge(() => SERVER)
    await globalThis.fetch(`${SERVER}/api/auth/logout`, { method: "POST" })

    await vi.waitFor(() => expect(bridge.getState().runtimeLocation).toBe("liaison"))
    expect(localStorage.getItem(RUNTIME_LOCATION_MIRROR_KEY)).toBeNull()
    // The page is TOLD, rather than finding out on its next reload.
    expect(seen).toContain("liaison")
    expect(recorder.calls[0].header).toBe("rt-one")
  })

  // ONE TOKEN PER SERVER, RELEASED ONLY FOR THE CURRENT ONE. The bridge names
  // the server it is about to present the token to, and the shell answers only
  // when that is its current server (servers.rs). A page still pointed at the
  // server the window just left gets nothing, so its token never reaches the
  // next server, and the next server's never reaches it.
  it("names the server it presents the token to, and a server that is not current gets none", async () => {
    const shell = { current: SERVER, tokens: new Map([[SERVER, "rt-a"]]) }
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "load_refresh_token") {
        return args?.server === shell.current ? (shell.tokens.get(shell.current) ?? null) : null
      }
      if (command === "store_refresh_token") {
        if (args?.server !== shell.current) throw "NotCurrentServer"
        shell.tokens.set(shell.current, args?.token as string)
        return undefined
      }
      return undefined
    })
    const recorder = fetchRecorder()
    let bound = SERVER
    installRefreshBridge(() => bound)

    await globalThis.fetch(`${SERVER}/api/auth/refresh`, { method: "POST" })
    expect(recorder.calls[0].header).toBe("rt-a")

    // The shell moved to another server; this page has not started again yet.
    shell.current = "https://liaison.fabrikam.example"
    recorder.answerWith({ data: { accessToken: "x", refreshToken: "rt-a-rotated" } })
    await globalThis.fetch(`${SERVER}/api/auth/refresh`, { method: "POST" })
    expect(recorder.calls[1].header).toBeNull()
    expect(shell.tokens.get("https://liaison.fabrikam.example")).toBeUndefined()

    bound = "https://liaison.fabrikam.example"
    await globalThis.fetch("https://liaison.fabrikam.example/api/auth/refresh", { method: "POST" })
    expect(recorder.calls[2].header).toBeNull()
  })

  it("clears the token on logout and sends it to no other origin", async () => {
    let stored: string | null = "rt-one"
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "store_refresh_token") {
        stored = (args?.token as string) || null
        return undefined
      }
      if (command === "load_refresh_token") return stored
      return undefined
    })

    const recorder = fetchRecorder()
    installRefreshBridge(() => SERVER)

    await globalThis.fetch("https://evil.example/api/auth/refresh", { method: "POST" })
    expect(recorder.calls[0].header).toBeNull()

    await globalThis.fetch(`${SERVER}/api/auth/logout`, { method: "POST" })
    await vi.waitFor(() => expect(stored).toBeNull())
  })
})
