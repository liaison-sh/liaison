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

/** Is `url`'s host a loopback address (localhost, 127.0.0.0/8, ::1)? False for anything unparsable. */
export function isLoopbackOrigin(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "[::1]" || host === "::1") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * The pure half of `isPublicDemoInstance`: demo mode on, and not BOTH declared
 * private (LIAISON_PRIVATE_DEMO_BOX) and served on a loopback BASE_URL.
 */
export function publicDemoInstance(input: {
  demoMode: boolean
  declaredPrivate: boolean
  baseUrl: string
}): boolean {
  if (!input.demoMode) return false
  return !(input.declaredPrivate && isLoopbackOrigin(input.baseUrl))
}

/**
 * Is this process a demo instance visitors can reach? The seed's refusals that
 * protect visitors (replacing a demo org, giving seeded people passwords) key
 * on this rather than on demo mode alone: a private demo-mode box (a tester's
 * throwaway box behind a tunnel) has no visitors, so the refusals have nothing
 * to protect there. Both keys are needed to call a box private, the explicit
 * declaration and a loopback BASE_URL, so a public hostname always reads as
 * public.
 */
export function isPublicDemoInstance(): boolean {
  return publicDemoInstance({
    demoMode: isDemoModeEnabled(),
    declaredPrivate: env.LIAISON_PRIVATE_DEMO_BOX,
    baseUrl: env.BASE_URL,
  })
}
