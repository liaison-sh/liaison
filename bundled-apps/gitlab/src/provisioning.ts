// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Declarative setup (`config apply` / `config verify`). GitLab needs nothing
// beyond its connection, so the handler changes nothing; `verify` is the live
// check `config verify` and the post-apply health check run: the cheapest
// authenticated read GitLab offers (the token owner's profile) and the
// connected group, through the connection's own credential (never read here).

import { connectedGroup, encodeId, type GitlabCtx, getJson } from "./client"
import { toolError } from "./tools"

export async function provisionGitlab(
  _input: { config?: Record<string, unknown>; dryRun?: boolean },
  _ctx: GitlabCtx,
): Promise<{ changed: string[] }> {
  return { changed: [] }
}

export async function verifyGitlab(
  _input: { config?: Record<string, unknown> },
  ctx: GitlabCtx,
): Promise<{ ok: boolean; problems: string[]; identity?: string }> {
  try {
    const group = await connectedGroup(ctx)
    const user = await getJson<{ username: string }>(ctx, "/user")
    const found = await getJson<{ full_path?: string }>(
      ctx,
      `/groups/${encodeId(group)}?with_projects=false`,
    )
    return { ok: true, problems: [], identity: `${user.username} @ ${found.full_path ?? group}` }
  } catch (err) {
    const { error } = toolError(err)
    return { ok: false, problems: [`${error.code}: ${error.message}`] }
  }
}
