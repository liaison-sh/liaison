// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Session-lifecycle enforcement guard (I-WEB-1, hardened).
 *
 * The documented convention: every store that holds per-user/per-org state must
 * reset on logout by registering `onSessionTeardown(resetXxxStore)`. On a shared
 * device this is the boundary that prevents user A's loaded data leaking into
 * user B's session.
 *
 * The PREVIOUS guard only inspected files that already exported
 * `resetXxxStore` — so a store that shipped with only a test-only
 * `_resetForTest` name was invisible to it. This rewrite enumerates stores
 * from their REAL signal — a module-scope `createStore(...)` call under
 * `src/modules/**` — and requires each to register `onSessionTeardown` with a
 * REAL reset fn (a name starting with `reset`, never the test-only
 * `_resetForTest` / `_reset…ForTest`).
 *
 * `KNOWN_TEARDOWN_GAPS` pins today's offenders (annotated with finding ID +
 * draining wave) so the guard is GREEN now while biting on any NEW store that
 * forgets teardown. Drop each entry as its fix lands.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const srcDir = path.resolve(__dirname, "..")
const modulesDir = path.join(srcDir, "modules")

/**
 * Stores that hold a module-scope `createStore` under `src/modules/**` but do
 * NOT yet register `onSessionTeardown`. Path is relative to `src/`. Seeded with
 * exactly today's gaps so the guard passes now; each annotated with finding ID
 * and the wave that fixes it. Remove the entry when the store registers a real
 * reset fn.
 */
const KNOWN_TEARDOWN_GAPS = new Set<string>([
  // Attention store holds the org's attention items at module scope with no
  // teardown — same family as I-WEB-3/17. Add `resetAttentionStore` + register.
  "modules/shell/attention-store.ts",
])

function findStoreFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== "node_modules") {
      out.push(...findStoreFiles(full))
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full)
    }
  }
  return out
}

/** A top-level (module-scope) `const [..] = createStore(..)` — not an indented
 *  in-component call. The signal that the file owns persistent session state. */
const MODULE_SCOPE_CREATE_STORE = /^(?:export )?const \[[^\]]*\]\s*=\s*createStore[<(]/m

/** Real reset fn passed to onSessionTeardown: starts with `reset`, never `_`. */
const REAL_TEARDOWN_REGISTRATION = /onSessionTeardown\(\s*(reset[A-Za-z0-9_]*)\b/

describe("session lifecycle enforcement (I-WEB-1)", () => {
  // The set of module-scope store files, computed once.
  const storeFiles = findStoreFiles(modulesDir).filter((f) =>
    MODULE_SCOPE_CREATE_STORE.test(fs.readFileSync(f, "utf-8")),
  )

  it("discovers a non-trivial set of module-scope stores", () => {
    // Guards against the directory walk silently finding nothing (which would
    // make every assertion below vacuously pass).
    expect(storeFiles.length).toBeGreaterThan(15)
  })

  it("every module-scope store under src/modules/** registers a REAL reset fn via onSessionTeardown", () => {
    const violations: string[] = []
    for (const file of storeFiles) {
      const rel = path.relative(srcDir, file)
      if (KNOWN_TEARDOWN_GAPS.has(rel)) continue
      const content = fs.readFileSync(file, "utf-8")

      if (!content.includes('from "~/lib/session-lifecycle"')) {
        violations.push(`${rel}: module-scope store does not import ~/lib/session-lifecycle`)
        continue
      }
      const m = content.match(REAL_TEARDOWN_REGISTRATION)
      if (!m) {
        violations.push(
          `${rel}: module-scope store does not call onSessionTeardown(reset…) with a real reset fn ` +
            `(test-only names like _resetForTest do NOT count)`,
        )
        continue
      }
      // Defense in depth: the registered name must actually be exported/defined
      // as a function in the file (not an imported test stub).
      const fnName = m[1]
      const definesFn =
        content.includes(`function ${fnName}`) || new RegExp(`const ${fnName}\\s*=`).test(content)
      if (!definesFn) {
        violations.push(`${rel}: registers ${fnName} but does not define it in the file`)
      }
    }
    expect(violations).toEqual([])
  })

  it("every KNOWN_TEARDOWN_GAPS entry is still a real, still-unfixed gap", () => {
    // Keep the allowlist honest: an entry that has been fixed (now registers a
    // real reset fn) or whose file is gone must be removed, not left to mask a
    // future regression.
    const stale: string[] = []
    for (const rel of KNOWN_TEARDOWN_GAPS) {
      const abs = path.join(srcDir, rel)
      if (!fs.existsSync(abs)) {
        stale.push(`${rel} (file gone — remove the allowlist entry)`)
        continue
      }
      const content = fs.readFileSync(abs, "utf-8")
      if (!MODULE_SCOPE_CREATE_STORE.test(content)) {
        stale.push(`${rel} (no longer a module-scope store — remove the allowlist entry)`)
        continue
      }
      if (REAL_TEARDOWN_REGISTRATION.test(content)) {
        stale.push(`${rel} (now registers a real reset fn — gap fixed, remove the allowlist entry)`)
      }
    }
    expect(stale).toEqual([])
  })
})
