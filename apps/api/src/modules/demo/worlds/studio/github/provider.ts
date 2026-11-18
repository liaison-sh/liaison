// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The interception point: the services world's GitHub reads never leave the box.
//
// The sandbox fetch bridge (`ctx.fetch`) calls `maybeDemoGithubResponse` once
// per outbound call, after the store, carrier and card-payments stand-ins.
//
// Gate one, the request: only a request carrying the stand-in's sentinel token
// (`fixtureConnectionOf`) is this module's business. Anything else returns
// null before any read, and a demo org's other GitHub traffic is refused
// further on by `assertDemoAppFetchAllowed` on a demo box, as before.
//
// Gate two, the org, read on every box whatever its demo mode (a year box or
// a self-hosted install seeds the services world with demo mode off): an org
// without the demo marker gets `fixtureRefusal("github")`, a demo org that
// names another world is refused in words, and neither request is forwarded.
// A sentinel request is never put on the wire.
//
// Past both, the stand-in answers in GitHub's own response shape from the
// world's history (fixture.ts), dated from the anchor the seed stored with the
// connection: reads only, the world's owner only, with GitHub's pagination.
import { DemoRestrictionError, demoRestrictionMessage } from "~/modules/demo/demo-egress"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import { fixtureConnectionOf, fixtureRefusal } from "~/modules/demo/fixture-credential"
import { GITHUB_APP } from "./sentinel"

export interface DemoGithubRequest {
  orgId: string
  url: string
  method: string
  /** The request's headers, credential included (injected by the host). */
  headers?: Record<string, string>
}

/**
 * The stand-in's answer to this request, or null when the request is none of
 * its business. Throws `DemoRestrictionError` for a demo org of another world.
 */
export async function maybeDemoGithubResponse(
  request: DemoGithubRequest,
): Promise<Response | null> {
  // Gate one: the request.
  if (fixtureConnectionOf(request.url, request.headers) !== GITHUB_APP) return null

  // Gate two: the org.
  const { marker, locale } = await loadDemoOrg(request.orgId)
  if (!marker) return fixtureRefusal(GITHUB_APP)
  const worldId = (marker as { worldId?: unknown }).worldId
  if (worldId !== undefined && worldId !== "studio") {
    throw new DemoRestrictionError(demoRestrictionMessage("app_fetch", locale), "app_fetch")
  }
  const { answerDemoGithub } = await import("./answer")
  return answerDemoGithub({ orgId: request.orgId, url: request.url, method: request.method })
}
