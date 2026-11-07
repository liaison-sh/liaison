// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { env } from "~/lib/env"
import {
  bridgeUrlFor,
  readWorkersConfig,
  readWorkersSelection,
  workersBundleSha,
  workersSelectsApp,
} from "./config"

const KEYS = [
  "LIAISON_WORKERS_APPS",
  "LIAISON_APP_LOADER_URL",
  "LIAISON_APP_LOADER_CELL_ID",
  "LIAISON_APP_LOADER_KEY",
  "LIAISON_WORKERS_BUNDLES",
  "LIAISON_APP_BRIDGE_BASE_URL",
  "LIAISON_WORKERS_CUSTOM_APPS",
] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]))
const savedRole = env.LIAISON_ROLE
const SHA = "a".repeat(64)

function setAll(): void {
  env.LIAISON_WORKERS_APPS = "shopify, boxtal"
  env.LIAISON_APP_LOADER_URL = "https://loader.example.com/"
  env.LIAISON_APP_LOADER_CELL_ID = "cell-1"
  env.LIAISON_APP_LOADER_KEY = "k"
  env.LIAISON_WORKERS_BUNDLES = JSON.stringify({ "shopify@0.4.1": SHA })
  env.LIAISON_APP_BRIDGE_BASE_URL = undefined
  env.LIAISON_WORKERS_CUSTOM_APPS = undefined
  env.LIAISON_ROLE = "all"
}

function setLoaderOnly(): void {
  for (const k of KEYS) (env as Record<string, unknown>)[k] = undefined
  env.LIAISON_APP_LOADER_URL = "https://loader.example.com"
  env.LIAISON_APP_LOADER_CELL_ID = "cell-1"
  env.LIAISON_APP_LOADER_KEY = "k"
  env.LIAISON_ROLE = "all"
}

const CUSTOM = "returns-o1a2b3c4d"

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

  it("is used when everything is set and the role is all", () => {
    setAll()
    const cfg = readWorkersConfig()
    expect(cfg).not.toBeNull()
    if (!cfg) return
    expect([...cfg.apps]).toEqual(["shopify", "boxtal"])
    expect(cfg.loaderUrl).toBe("https://loader.example.com")
    expect(cfg.bridgeBaseUrl).toBe(env.BASE_URL.replace(/\/+$/, ""))
    expect(workersBundleSha(cfg, "shopify", "0.4.1")).toBe(SHA)
    expect(workersBundleSha(cfg, "shopify", "0.4.2")).toBeUndefined()
    expect(workersBundleSha(cfg, "boxtal", "0.23.3")).toBeUndefined()
    expect(bridgeUrlFor(cfg, "r1")).toBe(`${cfg.bridgeBaseUrl}/api/app-bridge/r1`)
  })

  it("is refused under another role", () => {
    setAll()
    env.LIAISON_ROLE = "worker"
    expect(readWorkersSelection().kind).toBe("invalid")
  })

  it("is refused when partly set or with a bad bundle map", () => {
    setAll()
    env.LIAISON_APP_LOADER_KEY = undefined
    expect(readWorkersSelection()).toEqual({
      kind: "invalid",
      reason: "missing LIAISON_APP_LOADER_KEY",
    })
    setAll()
    env.LIAISON_WORKERS_BUNDLES = "{nope"
    expect(readWorkersSelection().kind).toBe("invalid")
    env.LIAISON_WORKERS_BUNDLES = JSON.stringify({ shopify: SHA })
    expect(readWorkersSelection().kind).toBe("invalid")
    env.LIAISON_WORKERS_BUNDLES = JSON.stringify({ "shopify@1.0.0": "XYZ" })
    expect(readWorkersSelection().kind).toBe("invalid")
  })

  it("selects custom apps only with LIAISON_WORKERS_CUSTOM_APPS=1", () => {
    setAll()
    const listedOnly = readWorkersConfig()
    expect(listedOnly?.customApps).toBe(false)
    if (!listedOnly) return
    expect(workersSelectsApp(listedOnly, "shopify")).toBe(true)
    expect(workersSelectsApp(listedOnly, CUSTOM)).toBe(false)

    env.LIAISON_WORKERS_CUSTOM_APPS = "1"
    const both = readWorkersConfig()
    expect(both?.customApps).toBe(true)
    if (!both) return
    expect(workersSelectsApp(both, CUSTOM)).toBe(true)
    expect(workersSelectsApp(both, "shopify")).toBe(true)
    // A first-party name never takes the custom shape: not selected by the switch.
    expect(workersSelectsApp(both, "boxtal-x")).toBe(false)
  })

  it("needs neither LIAISON_WORKERS_APPS nor LIAISON_WORKERS_BUNDLES with custom apps on", () => {
    setLoaderOnly()
    expect(readWorkersSelection()).toEqual({
      kind: "invalid",
      reason: "missing LIAISON_WORKERS_APPS, LIAISON_WORKERS_BUNDLES",
    })
    env.LIAISON_WORKERS_CUSTOM_APPS = "1"
    const cfg = readWorkersConfig()
    expect(cfg).not.toBeNull()
    if (!cfg) return
    expect(cfg.customApps).toBe(true)
    expect(cfg.apps.size).toBe(0)
    expect(cfg.bundles.size).toBe(0)
    expect(workersSelectsApp(cfg, CUSTOM)).toBe(true)
    expect(workersSelectsApp(cfg, "shopify")).toBe(false)
    // Listed apps alone, with custom apps on: no bundle map needed either.
    env.LIAISON_WORKERS_APPS = "shopify"
    expect(readWorkersConfig()?.apps.has("shopify")).toBe(true)
  })

  it("still needs the loader variables, a valid switch and role all with custom apps on", () => {
    setLoaderOnly()
    env.LIAISON_WORKERS_CUSTOM_APPS = "1"
    env.LIAISON_APP_LOADER_KEY = undefined
    expect(readWorkersSelection()).toEqual({
      kind: "invalid",
      reason: "missing LIAISON_APP_LOADER_KEY",
    })
    setLoaderOnly()
    env.LIAISON_WORKERS_CUSTOM_APPS = "yes"
    expect(readWorkersSelection().kind).toBe("invalid")
    setLoaderOnly()
    env.LIAISON_WORKERS_CUSTOM_APPS = "1"
    env.LIAISON_ROLE = "api"
    expect(readWorkersSelection().kind).toBe("invalid")
    // The switch alone (no loader) is a misconfiguration worth the warning, not unset.
    for (const k of KEYS) (env as Record<string, unknown>)[k] = undefined
    env.LIAISON_ROLE = "all"
    env.LIAISON_WORKERS_CUSTOM_APPS = "1"
    expect(readWorkersSelection().kind).toBe("invalid")
    env.LIAISON_WORKERS_CUSTOM_APPS = "0"
    expect(readWorkersSelection()).toEqual({ kind: "unset" })
  })
})
