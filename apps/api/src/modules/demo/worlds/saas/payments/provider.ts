// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The interception point: a demo org's card-payments traffic never leaves the box.
//
// The sandbox fetch bridge calls `maybeDemoPaymentsResponse` once per outbound
// call, after the store and carrier stand-ins. On a normal deployment the cost
// is two module-local booleans (demo mode, `LIAISON_DEMO_PAYMENTS_FIXTURES`)
// and a string compare per header: the function returns null before it parses
// the URL or reads anything. The stand-in itself is behind a dynamic import.
//
// Gate one, the process: demo mode on (the public demo box), or
// `LIAISON_DEMO_PAYMENTS_FIXTURES` set (a private walk, bench or year box that
// runs the product as it ships and holds demo-marked orgs), or the request
// carries the stand-in's sentinel key, which opens it on ANY box: that
// connection holds no real key and must never reach the processor.
//
// Gate two, the request: the payments app calling a host its own connection
// declares (`allowedDomains`).
//
// Gate three, the org: an org without the demo marker is not a demo org, so
// its call is forwarded exactly as before (a sentinel request from such an org
// is refused, never forwarded).
//
// For a demo org past all three, the processor is a closed door: the stand-in
// answers or refuses. A demo org whose connection somehow holds anything but
// the sentinel (a real key) is refused with the connector sentence and its key
// is never used.
import { env } from "~/lib/env"
import { DemoRestrictionError, demoRestrictionMessage } from "~/modules/demo/demo-egress"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import { fixtureConnectionOf, fixtureRefusal } from "~/modules/demo/fixture-credential"
import { isDeclaredPaymentsHost, PAYMENTS_APP } from "./sentinel"

export interface DemoPaymentsRequest {
  orgId: string
  /** The calling app. */
  appName: string
  /** The hosts the calling app's install may reach (its manifest's `allowedDomains`). */
  allowedDomains: readonly string[]
  url: string
  method: string
  body: string | undefined
  /** The request's headers, credential included (injected by the host). */
  headers?: Record<string, string>
}

function idempotencyKeyOf(headers: Record<string, string> | undefined): string | null {
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === "idempotency-key" && typeof v === "string" && v) return v
  }
  return null
}

/**
 * The stand-in's answer to this request, or null when this box, this request
 * or this org is none of the stand-in's business. Throws `DemoRestrictionError`
 * for a refusal a demo org reads.
 */
export async function maybeDemoPaymentsResponse(
  request: DemoPaymentsRequest,
): Promise<Response | null> {
  // Gate one: the process (or the sentinel key itself).
  const fixture = fixtureConnectionOf(request.url, request.headers) === PAYMENTS_APP
  if (!isDemoModeEnabled() && !env.LIAISON_DEMO_PAYMENTS_FIXTURES && !fixture) return null

  // Gate two: the payments app, on a host it declares.
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  const declared =
    request.appName === PAYMENTS_APP && isDeclaredPaymentsHost(url.hostname, request.allowedDomains)
  if (!declared && !fixture) return null

  // Gate three: the org.
  const { marker, locale } = await loadDemoOrg(request.orgId)
  if (!marker) return fixture ? fixtureRefusal(PAYMENTS_APP) : null

  // A demo org's connection carries the sentinel and nothing else: anything
  // else is a real key, refused and never sent.
  if (!fixture) {
    throw new DemoRestrictionError(
      demoRestrictionMessage("connector_credentials", locale),
      "connector_credentials",
    )
  }
  const { answerDemoPayments } = await import("./standin")
  return answerDemoPayments({
    orgId: request.orgId,
    url,
    method: request.method,
    body: request.body,
    idempotencyKey: idempotencyKeyOf(request.headers),
    locale,
  })
}
