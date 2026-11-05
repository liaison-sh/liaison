// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ReDoS check of a manifest pattern never parks this thread on a Worker: that
// wait has no deadline, and a Worker that deadlocks holds the whole event loop.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import type { SchemaObject } from "ajv"
import mcpManager from "../apps/mcp-manager/app.manifest.json"
import { defaultFillerCompileError } from "../modules/apps/param-validator"
import { manifestRegExp } from "./manifest-regex"

describe("the manifest pattern check", () => {
  const started: string[] = []
  const realWorker = globalThis.Worker
  const realWait = Atomics.wait

  beforeEach(() => {
    started.length = 0
    globalThis.Worker = class extends realWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        started.push(String(url))
        super(url, options)
      }
    } as typeof Worker
  })

  afterEach(() => {
    globalThis.Worker = realWorker
    Atomics.wait = realWait
  })

  it("runs on this thread: no Worker and no Atomics.wait", () => {
    const wait = spyOn(Atomics, "wait")
    expect(manifestRegExp(`^backend-check-${crypto.randomUUID()}[a-z]+$`).test("x")).toBe(false)
    expect(started).toEqual([])
    expect(wait).not.toHaveBeenCalled()
  })

  it("still refuses a pattern that can backtrack catastrophically", () => {
    expect(() => manifestRegExp(`^(a+)+${crypto.randomUUID()}$`)).toThrow("backtrack")
  })
})

// Regression: a server too slow to finish the check in time left a shipped app in
// status=error, while a faster one running the same code loaded it. The ceiling here
// is 1 ms: no machine could finish a check in it, so only a verdict that needs no
// check on this machine passes.
describe("a pattern the repo ships", () => {
  const ssrfGuard = mcpManager.tools.add_connection.params.properties.httpUrl.pattern
  const SLOWEST_MACHINE_MS = 1

  it("loads whatever this machine's speed", () => {
    expect(
      manifestRegExp(ssrfGuard, "u", SLOWEST_MACHINE_MS).test("https://mcp.example.com/x"),
    ).toBe(true)
  })

  it("passes the registration compile that refused the app", () => {
    expect(
      defaultFillerCompileError(mcpManager.tools.add_connection.params as SchemaObject, {
        allErrors: true,
        allowUnionTypes: true,
      }),
    ).toBeUndefined()
  })

  it("keeps refusing the private addresses it exists to refuse", () => {
    const re = manifestRegExp(ssrfGuard, "u")
    for (const url of [
      "http://mcp.example.com",
      "https://localhost/x",
      "https://localhost:8080",
      "https://[::1]:3000/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3:9000",
      "https://0.0.0.0/x",
      "https://192.168.1.1/x",
      "https://169.254.169.254/latest",
      "https://172.16.0.1/x",
      "https://172.31.255.255?x",
    ]) {
      expect(re.test(url)).toBe(false)
    }
    expect(re.test("https://172.32.0.1/x")).toBe(true)
  })

  it("is trusted only exactly as it ships: other flags are checked and fail closed", () => {
    expect(() => manifestRegExp(ssrfGuard, "", SLOWEST_MACHINE_MS)).toThrow("could not be proven")
  })

  it("is trusted only exactly as it ships: a pattern one character off is checked", () => {
    const stranger = `^https://(?!${crypto.randomUUID()})${ssrfGuard.slice("^https://".length)}`
    expect(() => manifestRegExp(stranger, "u", SLOWEST_MACHINE_MS)).toThrow("could not be proven")
    // A refusal under a short ceiling does not stick to a long one.
    expect(manifestRegExp(stranger, "u").test("https://mcp.example.com/x")).toBe(true)
  }, 60_000)
})
