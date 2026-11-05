// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The interception point: a demo org's Shopify traffic never leaves the box.
//
// The sandbox fetch bridge calls `maybeDemoShopifyResponse` once per outbound
// call. On a normal deployment the whole cost is ONE boolean read of a
// module-local (`isDemoModeEnabled()`), which is false, and the function
// returns null before it parses the URL, touches the database or imports a
// fixture. The demo tree is not even loaded: the fixtures, the search parser
// and the node builders are behind a dynamic import that only a demo request
// reaches.
//
// A private QA box sets `LIAISON_DEMO_SHOPIFY_FIXTURES` instead: it runs the
// product as it ships, with demo mode off, and still needs a demo marked org's
// Shopify screens to hold the fixture shop. That flag widens gate one alone.
//
// On the demo box the second gate is the ORG: an org without the demo marker is
// not a demo org, so its egress is forwarded exactly as today. That keeps the
// mechanism keyed on data rather than on a global that would have to be right
// for every tenant at once, and it is the same two-condition gate the mail and
// credential doors use.
//
// For an org that passes BOTH gates, `*.myshopify.com` is a closed door: the
// request is either answered from fixtures or refused. It is never forwarded.
// That is the containment that makes the demo connection safe to ship — even a
// connection somehow carrying a real token could not reach a real store.
import { env } from "~/lib/env"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import { fixtureConnectionOf, fixtureRefusal } from "~/modules/demo/fixture-credential"
import {
  demoShopifyUnsupportedMessage,
  demoShopifyWriteBlockedMessage,
  isShopifyAdminHost,
} from "./sentinel"

export interface DemoShopifyRequest {
  orgId: string
  url: string
  method: string
  body: string | undefined
  /** The request's headers: a sentinel credential marks a fixture connection. */
  headers?: Record<string, string>
}

/** Shopify's own cost envelope, so the client's throttle logic sees a sane bucket. */
const EXTENSIONS = {
  cost: {
    requestedQueryCost: 1,
    actualQueryCost: 1,
    throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 2000, restoreRate: 100 },
  },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/**
 * The fixture answer for this request, or null when this box / this org / this
 * host is none of the demo's business.
 */
export async function maybeDemoShopifyResponse(
  request: DemoShopifyRequest,
): Promise<Response | null> {
  // Gate one: the process. Two module-local booleans, and a normal deployment
  // stops here having done nothing else at all.
  //
  // The second one, `LIAISON_DEMO_SHOPIFY_FIXTURES`, is the private QA box:
  // it runs the product as it ships, with demo mode off, and is filled with
  // the demo world so a tester can walk it. It opens THIS door and no other,
  // and only for an org that passes gate two below. See its note in env.ts.
  //
  // A request of the seeded fixture connection itself (the sentinel token, or
  // the fixed demo shop) opens it on ANY box: that connection holds no real
  // credential and must never reach Shopify (fixture-credential.ts).
  const fixture = fixtureConnectionOf(request.url, request.headers) === "shopify"
  if (!isDemoModeEnabled() && !env.LIAISON_DEMO_SHOPIFY_FIXTURES && !fixture) return null

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  if (!isShopifyAdminHost(url.hostname)) return null

  // Gate two: the org. A fixture request from an org without the demo world
  // is refused, never forwarded.
  const { marker, locale } = await loadDemoOrg(request.orgId)
  if (!marker) return fixture ? fixtureRefusal("shopify") : null

  // Answered from this process's replica of the org's store: the writes every
  // process made, and the scenario's live order (replica.ts).
  const { answerReplicatedDemoShopify } = await import("./replica")
  return answerReplicatedDemoShopify({
    orgId: request.orgId,
    path: url.pathname,
    method: request.method,
    body: request.body,
    unsupported: demoShopifyUnsupportedMessage(locale),
    writeBlocked: demoShopifyWriteBlockedMessage(locale),
    json,
    extensions: EXTENSIONS,
  })
}
