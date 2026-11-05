// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo-mode gate, in one place.
//
// `LIAISON_DEMO_MODE` is parsed by the strict boolean parser (env-boolean.ts),
// so the string "false" is false: `z.coerce.boolean()` would make it true and a
// deployment that wrote LIAISON_DEMO_MODE=false to be explicit would have
// turned the public signup route ON. It defaults to false, it is never fatal,
// and it is independent of NODE_ENV: a test run is not a demo instance and a
// demo instance is a real production deployment.
//
// app.ts reads `env.LIAISON_DEMO_MODE` directly for the MOUNT decision, because
// when the flag is off the demo routes must not exist at all rather than exist
// and refuse. Everything downstream of a mounted route reads `isDemoModeEnabled()`
// so the restriction half of demo mode (egress lockdown, spend ceiling) is
// testable in-process without re-importing the whole app under a different env.
import { env } from "~/lib/env"

let override: boolean | null = null

/** Is this process the public demo instance? */
export function isDemoModeEnabled(): boolean {
  return override ?? env.LIAISON_DEMO_MODE
}

/**
 * The one seam tests use to exercise the ON side of the gate in a process that
 * booted with it off. `null` in production, always — nothing in `src/` calls
 * `set`, and a grep for `DemoModeTestAccess` outside a `.test.ts` should return
 * nothing.
 */
export const DemoModeTestAccess = {
  set(value: boolean | null): void {
    override = value
  },
  get(): boolean | null {
    return override
  },
}
