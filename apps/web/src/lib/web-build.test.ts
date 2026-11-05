// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApiClient } from "~/lib/api-client"
import {
  CHECK_INTERVAL_MS,
  createWebBuildWatcher,
  insideAppShell,
  installWebBuildWatcher,
  isRealBuildId,
  pageHasUnsavedWork,
  pageWebBuildId,
  RELOADED_FOR_KEY,
  WEB_BUILD_HEADER,
  WEB_BUILD_META_NAME,
  type WebBuildEnv,
} from "~/lib/web-build"
import { bakeWebBuildId, computeWebBuildId } from "~/lib/web-build-id-plugin"

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

function setup(over: Partial<WebBuildEnv> = {}) {
  const reload = vi.fn()
  const fetchServerId = vi.fn(async () => "new" as string | null)
  let clock = 1_000_000
  const env: WebBuildEnv = {
    compiledId: "old",
    inShell: () => false,
    hasUnsavedWork: () => false,
    reload,
    fetchServerId,
    storage: memoryStorage(),
    now: () => clock,
    ...over,
  }
  const watcher = createWebBuildWatcher(env)
  return { watcher, reload, fetchServerId, env, advance: (ms: number) => (clock += ms) }
}

describe("web build watcher", () => {
  it("does nothing when the server ships the build this page runs", () => {
    const { watcher, reload } = setup()
    watcher.observe("old")
    watcher.onVisibilityChange(false)
    watcher.onNavigate()
    expect(reload).not.toHaveBeenCalled()
    expect(watcher.bannerVisible()).toBe(false)
  })

  it("reloads once, on the next visibility change, when a newer build is out and nothing is unsaved", () => {
    const { watcher, reload, env } = setup()
    watcher.observe("new")
    // Not on the response itself: the person may be mid-click.
    expect(reload).not.toHaveBeenCalled()
    watcher.onVisibilityChange(false)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(env.storage?.getItem(RELOADED_FOR_KEY)).toBe("new")
    expect(watcher.bannerVisible()).toBe(false)
  })

  it("reloads on the next navigation too", () => {
    const { watcher, reload } = setup()
    watcher.observe("new")
    watcher.onNavigate()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("shows the banner instead of reloading while a draft or upload would be lost", () => {
    const { watcher, reload } = setup({ hasUnsavedWork: () => true })
    watcher.observe("new")
    watcher.onVisibilityChange(true)
    watcher.onNavigate()
    expect(reload).not.toHaveBeenCalled()
    expect(watcher.bannerVisible()).toBe(true)
  })

  it("never reload-loops: a page still on the old build after reloading for this id shows the banner", () => {
    const storage = memoryStorage()
    const first = setup({ storage })
    first.watcher.observe("new")
    first.watcher.onVisibilityChange(false)
    expect(first.reload).toHaveBeenCalledTimes(1)

    // The reloaded page came back with the OLD bundle (a stale cache in front).
    const second = setup({ storage })
    second.watcher.observe("new")
    expect(second.watcher.bannerVisible()).toBe(true)
    second.watcher.onVisibilityChange(false)
    second.watcher.onNavigate()
    expect(second.reload).not.toHaveBeenCalled()

    // A later deploy is a new id, and gets its own single reload.
    second.watcher.observe("newer")
    second.watcher.onVisibilityChange(false)
    expect(second.reload).toHaveBeenCalledTimes(1)
  })

  it("does nothing inside the desktop or mobile shell", () => {
    const { watcher, reload, fetchServerId, advance } = setup({ inShell: () => true })
    watcher.observe("new")
    advance(CHECK_INTERVAL_MS + 1)
    watcher.onVisibilityChange(true)
    watcher.onFocus()
    watcher.onNavigate()
    expect(reload).not.toHaveBeenCalled()
    expect(fetchServerId).not.toHaveBeenCalled()
    expect(watcher.bannerVisible()).toBe(false)
  })

  it("does nothing in a build that carries no id (vite dev, tests)", () => {
    const { watcher, reload } = setup({ compiledId: "__LIAISON_WEB_BUILD_ID__" })
    watcher.observe("new")
    watcher.onNavigate()
    expect(reload).not.toHaveBeenCalled()
    expect(isRealBuildId("__LIAISON_WEB_BUILD_ID__")).toBe(false)
    expect(isRealBuildId("0123abcd0123abcd")).toBe(true)
  })

  it("checks build-id.txt on focus at most once per interval", async () => {
    const { watcher, fetchServerId, reload, advance } = setup()
    watcher.onFocus()
    expect(fetchServerId).not.toHaveBeenCalled()
    advance(CHECK_INTERVAL_MS)
    watcher.onFocus()
    watcher.onFocus()
    expect(fetchServerId).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    watcher.onVisibilityChange(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe("shell detection", () => {
  afterEach(() => {
    const g = globalThis as Record<string, unknown>
    delete g.__TAURI_INTERNALS__
    delete g.__LIAISON_NATIVE__
    delete g.__LIAISON_SERVER_ADDRESS__
  })

  it("is false in a plain browser tab and true under Tauri, Capacitor or an injected server", () => {
    const g = globalThis as Record<string, unknown>
    expect(insideAppShell()).toBe(false)
    g.__TAURI_INTERNALS__ = {}
    expect(insideAppShell()).toBe(true)
    delete g.__TAURI_INTERNALS__
    g.__LIAISON_NATIVE__ = {}
    expect(insideAppShell()).toBe(true)
    delete g.__LIAISON_NATIVE__
    g.__LIAISON_SERVER_ADDRESS__ = "https://liaison.example.com"
    expect(insideAppShell()).toBe(true)
  })
})

describe("unsaved work", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("counts uploads in flight and typed composer text", () => {
    expect(pageHasUnsavedWork(() => 0)).toBe(false)
    expect(pageHasUnsavedWork(() => 1)).toBe(true)
    const ta = document.createElement("textarea")
    document.body.append(ta)
    expect(pageHasUnsavedWork(() => 0)).toBe(false)
    ta.value = "half a reply"
    expect(pageHasUnsavedWork(() => 0)).toBe(true)
    ta.value = ""
    const ce = document.createElement("div")
    ce.setAttribute("contenteditable", "true")
    ce.textContent = "typed"
    document.body.append(ce)
    expect(pageHasUnsavedWork(() => 0)).toBe(true)
  })
})

describe("api client feeds the watcher", () => {
  afterEach(() => {
    installWebBuildWatcher(null)
    vi.unstubAllGlobals()
  })

  it("reports the X-Liaison-Web-Build header of every response", async () => {
    const observe = vi.fn()
    installWebBuildWatcher({
      observe,
      onVisibilityChange: () => {},
      onFocus: () => {},
      onNavigate: () => {},
      bannerVisible: () => false,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json", [WEB_BUILD_HEADER]: "srv-1" },
          }),
      ),
    )
    const client = createApiClient({
      baseUrl: "/api",
      getAccessToken: () => null,
      onUnauthorized: () => {},
    })
    await client.get("/ping")
    expect(observe).toHaveBeenCalledWith("srv-1")
  })
})

describe("build id plugin", () => {
  const bundle = () => ({
    "assets/index-a.js": {
      type: "chunk" as const,
      fileName: "assets/index-a.js",
      code: "const x=1;",
    },
    "index.html": {
      type: "asset" as const,
      fileName: "index.html",
      source: '<html><meta name="liaison-web-build" content="__LIAISON_WEB_BUILD_ID__">' as
        | string
        | Uint8Array,
    },
  })

  it("derives the id from content and bakes it into index.html, the one file never cached immutably", () => {
    const b = bundle()
    const expected = computeWebBuildId(bundle())
    const { id, patched } = bakeWebBuildId(b)
    expect(id).toBe(expected)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(patched).toEqual(["index.html"])
    expect(b["index.html"].source).toBe(`<html><meta name="liaison-web-build" content="${id}">`)
    expect(b["assets/index-a.js"].code).toBe("const x=1;")
    // Same content, same id: an unchanged redeploy prompts nobody.
    expect(computeWebBuildId(bundle())).toBe(expected)
    const changed = bundle()
    changed["assets/index-a.js"].code = "const x=2;"
    expect(computeWebBuildId(changed)).not.toBe(expected)
    // Vite may hand the page over as bytes.
    const bytes = bundle()
    bytes["index.html"].source = new TextEncoder().encode(bundle()["index.html"].source as string)
    expect(bakeWebBuildId(bytes).patched).toEqual(["index.html"])
  })

  it("refuses an index.html without the placeholder, and a JS chunk carrying it", () => {
    const noMeta = bundle()
    noMeta["index.html"].source = "<html>"
    expect(() => bakeWebBuildId(noMeta)).toThrow(/placeholder/)
    // A chunk keeps its hashed name when its source is unchanged, so an id
    // baked into it would be served stale from the immutable cache after a
    // deploy, and Reload could never clear the banner.
    const inChunk = bundle()
    inChunk["assets/index-a.js"].code = 'const x="__LIAISON_WEB_BUILD_ID__";'
    expect(() => bakeWebBuildId(inChunk)).toThrow(/chunk assets\/index-a\.js/)
  })
})

describe("page build id", () => {
  it("reads the id from index.html's meta tag, and null without one", () => {
    const meta = document.createElement("meta")
    meta.name = WEB_BUILD_META_NAME
    meta.content = "abc123"
    document.head.appendChild(meta)
    try {
      expect(pageWebBuildId()).toBe("abc123")
    } finally {
      meta.remove()
    }
    expect(pageWebBuildId()).toBeNull()
  })
})
