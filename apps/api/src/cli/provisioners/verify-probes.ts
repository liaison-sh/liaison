// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Per-app credential-verify probes for `liaison config verify`.
 *
 * A probe drives ONE cheap authenticated read through the app's OWN adapter
 * (never a raw fetch/curl) using the credential map the caller already
 * resolved through `getCredentialsForConnection` (the same decrypt path the
 * app's tools use — see `~/modules/apps/connections/service.ts`). It returns
 * a non-secret `identity` string (e.g. the remote username) to prove the
 * credential is live, and MUST NEVER return or log the credential values
 * themselves.
 *
 * This is a REGISTRY, not a switch statement: an app with no entry here is
 * reported `SKIPPED (no verify probe)` by the driver, never a hard failure.
 * Adding a new connector's probe is a one-line addition to this map — no
 * driver changes.
 */

import { makeGitlabFetchers } from "~/apps/gitlab/gitlab-rest"

/** Successful probe outcome — a non-secret identity string only. */
export interface VerifyProbeResult {
  identity: string
}

/**
 * A per-app probe. `credentials` is the fully-decrypted credential map for
 * the connection being checked. Throw (with a message safe to print — no
 * secrets) on failure; the driver maps that to a FAIL result.
 */
export type VerifyProbe = (credentials: Record<string, string>) => Promise<VerifyProbeResult>

async function verifyGitlab(credentials: Record<string, string>): Promise<VerifyProbeResult> {
  const token = credentials.token
  if (!token) throw new Error("stored credential has no 'token' field")
  // Same adapter the gitlab tools use (`makeGitlabFetchers`) — not a raw fetch.
  const client = makeGitlabFetchers(async () => token)
  const user = await client.getCurrentUser()
  return { identity: user.username }
}

/** App name → verify probe. Sparse: an app with no entry is SKIPPED. */
export const verifyProbeRegistry: Partial<Record<string, VerifyProbe>> = {
  gitlab: verifyGitlab,
}
