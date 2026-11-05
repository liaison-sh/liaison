// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Every durable kernel event the api emits is declared in KERNEL_DECLARED_EMITS.
 *
 * An undeclared kernel event throws at `tx.queueEvent` (assertKernelEventDeclared)
 * once the event bus is initialised, which is always the case in a running
 * server, but the check is skipped while the kernel set is empty, which is the
 * case in most unit tests. Two such events (`org_export:complete`,
 * `org_cap:threshold`) passed every test and failed in production: the export
 * started from Settings failed in a second and no cap notice was ever made.
 *
 * This is a static scan, so it does not depend on any test initialising the
 * bus: each object literal in `src/` (tests excluded) that carries
 * `app: "kernel"` with a literal `entity` and `action` is an emitted event.
 * Ephemeral broadcasts (`broadcastEphemeral(...)` or `ephemeral: true`) skip the
 * declaration by design and are left out. Events built from constants
 * (`entity: TOUR_WS_ENTITY`) are not seen; their modules pin them with their own
 * tests (e.g. security-event-declared.test.ts).
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Glob } from "bun"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"

const API_ROOT = path.resolve(import.meta.dir, "../../..")

interface EmitSite {
  where: string
  type: string
}

/** The object literal enclosing `at`, as [start, end] offsets of its braces. */
function enclosingObject(src: string, at: number): [number, number] | null {
  let depth = 0
  let start = at
  for (; start >= 0; start--) {
    const c = src[start]
    if (c === "}") depth++
    else if (c === "{") {
      if (depth === 0) break
      depth--
    }
  }
  if (start < 0) return null
  depth = 0
  let end = start + 1
  for (; end < src.length; end++) {
    const c = src[end]
    if (c === "{") depth++
    else if (c === "}") {
      if (depth === 0) break
      depth--
    }
  }
  return end < src.length ? [start, end] : null
}

function durableKernelEmitSites(): EmitSite[] {
  const sites: EmitSite[] = []
  for (const file of new Glob("src/**/*.ts").scanSync(API_ROOT)) {
    if (file.endsWith(".test.ts") || file.includes("/tests/")) continue
    const src = readFileSync(path.join(API_ROOT, file), "utf8")
    let i = src.indexOf('app: "kernel"')
    while (i !== -1) {
      const span = enclosingObject(src, i)
      if (span) {
        const body = src.slice(span[0], span[1] + 1)
        const entity = body.match(/\bentity:\s*"([a-z_]+)"/)?.[1]
        const action = body.match(/\baction:\s*"([a-z_]+)"/)?.[1]
        const ephemeral =
          /\bephemeral:\s*true\b/.test(body) ||
          /broadcastEphemeral\(\s*$/.test(src.slice(Math.max(0, span[0] - 40), span[0]))
        if (entity && action && !ephemeral) {
          const line = src.slice(0, i).split("\n").length
          sites.push({ where: `${file}:${line}`, type: `${entity}:${action}` })
        }
      }
      i = src.indexOf('app: "kernel"', i + 1)
    }
  }
  return sites
}

describe("kernel emit declarations", () => {
  const sites = durableKernelEmitSites()

  it("the scan sees the kernel's emit sites (a broken scan must not pass vacuously)", () => {
    expect(sites.length).toBeGreaterThan(50)
    expect(sites.some((s) => s.type === "message:create")).toBe(true)
  })

  it("every durable kernel event emitted in src/ is declared in KERNEL_DECLARED_EMITS", () => {
    const undeclared = sites
      .filter((s) => !KERNEL_DECLARED_EMITS.has(s.type))
      .map((s) => `${s.type} (${s.where})`)
    expect(undeclared).toEqual([])
  })
})
