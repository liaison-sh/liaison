// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { env } from "~/lib/env"
import {
  appBridgeEnabled,
  bridgeUrlFor,
  quickjsForced,
  readFallbackTarget,
  readSandboxConfig,
  readWorkersConfig,
  readWorkersSelection,
} from "./config"

const KEYS = [
  "LIAISON_APP_LOADER_URL",
  "LIAISON_APP_LOADER_CELL_ID",
  "LIAISON_APP_LOADER_KEY",
  "LIAISON_APP_BRIDGE_BASE_URL",
  "LIAISON_SANDBOX_URL",
  "LIAISON_SANDBOX_BRIDGE_URL",
  "LIAISON_APP_RUNTIME",
] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]))
const savedRole = env.LIAISON_ROLE

function setLoader(): void {
  env.LIAISON_APP_LOADER_URL = "https://loader.example.com/"
  env.LIAISON_APP_LOADER_CELL_ID = "cell-1"
  env.LIAISON_APP_LOADER_KEY = "k"
  env.LIAISON_APP_BRIDGE_BASE_URL = undefined
  env.LIAISON_ROLE = "all"
}

afterEach(() => {
  for (const k of KEYS) (env as Record<string, unknown>)[k] = saved[k]
  env.LIAISON_ROLE = savedRole
})

describe("workers config", () => {
  it("is unset by default", () => {
    for (const k of KEYS) (env as Record<string, unknown>)[k] = undefined
    expect(readWorkersSelection()).toEqual({ kind: "unset" })
    expect(readWorkersConfig()).toBeNull()
  })

  it("is used as soon as the three loader variables are set: no app list, no bundle map", () => {
    setLoader()
    const cfg = readWorkersConfig()
    expect(cfg).toEqual({
      loaderUrl: "https://loader.example.com",
      cellId: "cell-1",
      loaderKey: "k",
      bridgeBaseUrl: env.BASE_URL.replace(/\/+$/, ""),
    })
    if (!cfg) return
    expect(bridgeUrlFor(cfg, "r1")).toBe(`${cfg.bridgeBaseUrl}/api/app-bridge/r1`)
  })

  it("is used under every role: a worker process runs apps on Workers too", () => {
    for (const role of ["worker", "api", "all"] as const) {
      setLoader()
      env.LIAISON_ROLE = role
      const sel = readWorkersSelection()
      expect(sel.kind).toBe("workers")
      // Its isolates still call back on the public API's address.
      if (sel.kind === "workers") {
        expect(sel.config.bridgeBaseUrl).toBe(env.BASE_URL.replace(/\/+$/, ""))
      }
    }
    setLoader()
    env.LIAISON_ROLE = "worker"
    env.LIAISON_APP_BRIDGE_BASE_URL = "https://api.example.com/"
    expect(readWorkersConfig()?.bridgeBaseUrl).toBe("https://api.example.com")
  })

  it("is refused when partly set", () => {
    setLoader()
    env.LIAISON_APP_LOADER_KEY = undefined
    expect(readWorkersSelection()).toEqual({
      kind: "invalid",
      reason: "missing LIAISON_APP_LOADER_KEY",
    })
    for (const k of KEYS) (env as Record<string, unknown>)[k] = undefined
    env.LIAISON_APP_LOADER_URL = "https://loader.example.com"
    expect(readWorkersSelection()).toEqual({
      kind: "invalid",
      reason: "missing LIAISON_APP_LOADER_CELL_ID, LIAISON_APP_LOADER_KEY",
    })
  })
})

describe("fallback target", () => {
  it("is the local QuickJS sandbox while no sandbox service is configured", () => {
    setLoader()
    env.LIAISON_SANDBOX_URL = undefined
    const primary = readWorkersConfig()
    if (!primary) throw new Error("loader not configured")
    expect(readFallbackTarget(primary)).toEqual({ kind: "quickjs" })
  })

  it("is the instance's sandbox service once its URL is set: same cell, key and bridge", () => {
    setLoader()
    env.LIAISON_SANDBOX_URL = "http://sandbox.internal:8790/"
    const primary = readWorkersConfig()
    if (!primary) throw new Error("loader not configured")
    expect(readFallbackTarget(primary)).toEqual({
      kind: "workerd",
      config: { ...primary, loaderUrl: "http://sandbox.internal:8790" },
    })
  })
})

describe("the instance's sandbox service", () => {
  it("is absent while LIAISON_SANDBOX_URL is unset, and the bridge routes stay off", () => {
    for (const k of KEYS) (env as Record<string, unknown>)[k] = undefined
    expect(readSandboxConfig()).toBeNull()
    expect(appBridgeEnabled()).toBe(false)
  })

  it("without a loader: its own cell id, a per-process key, the bridge-only listener", () => {
    for (const k of KEYS) (env as Record<string, unknown>)[k] = undefined
    env.LIAISON_SANDBOX_URL = "http://sandbox:8790/"
    env.LIAISON_SANDBOX_BRIDGE_URL = "http://bridge:3100/"
    const cfg = readSandboxConfig()
    expect(cfg).toMatchObject({
      loaderUrl: "http://sandbox:8790",
      cellId: "sandbox",
      bridgeBaseUrl: "http://bridge:3100",
    })
    // A key exists to sign with (the service checks none) and is stable per process.
    expect(cfg?.loaderKey).toMatch(/^[0-9a-f]{64}$/)
    expect(readSandboxConfig()?.loaderKey).toBe(cfg?.loaderKey as string)
    expect(appBridgeEnabled()).toBe(true)
  })

  it("without the bridge listener's URL: the loader's bridge address, else BASE_URL", () => {
    for (const k of KEYS) (env as Record<string, unknown>)[k] = undefined
    env.LIAISON_SANDBOX_URL = "http://sandbox:8790"
    expect(readSandboxConfig()?.bridgeBaseUrl).toBe(env.BASE_URL.replace(/\/+$/, ""))
    setLoader()
    env.LIAISON_APP_BRIDGE_BASE_URL = "https://bridge.example.com"
    expect(readSandboxConfig()?.bridgeBaseUrl).toBe("https://bridge.example.com")
  })

  it("the fallback target calls back on the bridge-only listener when it is named", () => {
    setLoader()
    env.LIAISON_SANDBOX_URL = "http://sandbox:8790"
    env.LIAISON_SANDBOX_BRIDGE_URL = "http://bridge:3100"
    const primary = readWorkersConfig()
    if (!primary) throw new Error("loader not configured")
    expect(readFallbackTarget(primary)).toEqual({
      kind: "workerd",
      config: { ...primary, loaderUrl: "http://sandbox:8790", bridgeBaseUrl: "http://bridge:3100" },
    })
  })
})

describe("LIAISON_APP_RUNTIME", () => {
  it("forces QuickJS only when set to quickjs", () => {
    env.LIAISON_APP_RUNTIME = undefined
    expect(quickjsForced()).toBe(false)
    env.LIAISON_APP_RUNTIME = "quickjs"
    expect(quickjsForced()).toBe(true)
  })
})
