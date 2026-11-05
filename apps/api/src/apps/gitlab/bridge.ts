// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * GitLab connector — host-side RPC bridge extension.
 *
 * One method per tool. Each method:
 *   1. Resolves GitLab credentials from the connections store.
 *   2. Calls the appropriate `tools.ts` impl with those credentials.
 *   3. Returns the JSON-stringified result.
 *
 * No network calls happen in the sandbox (handlers.ts) — QuickJS never
 * touches the GitLab API.
 */

import type {
  BridgeExtensionContext,
  BridgeExtensionMethod,
} from "~/modules/apps/sandbox/bridge-extensions"

export function createGitlabBridgeExtension(
  ctx: BridgeExtensionContext,
): Record<string, BridgeExtensionMethod> {
  const { txDb, orgId, userId } = ctx

  async function resolveGitlabCreds(): Promise<{ token: string; group: string } | null> {
    try {
      const { getCredentialsForConnection } = await import("~/modules/apps/connections/service")
      const creds = await getCredentialsForConnection(txDb, orgId, userId, "gitlab", "gitlab")
      if (!creds.token || !creds.group) return null
      return { token: String(creds.token), group: String(creds.group) }
    } catch {
      return null
    }
  }

  function makeMethod<TParams>(
    toolFn: (ctx: import("./tools").GitlabToolCtx, params: TParams) => Promise<unknown>,
  ): BridgeExtensionMethod {
    return async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson) as TParams
      const creds = await resolveGitlabCreds()
      const toolCtx: import("./tools").GitlabToolCtx = { tx: txDb, orgId, userId, creds }
      const result = await toolFn(toolCtx, params)
      return JSON.stringify(result)
    }
  }

  return {
    gitlab_list_projects: makeMethod(async (ctx, params) => {
      const { gitlabListProjects } = await import("./tools")
      return gitlabListProjects(ctx, params as never)
    }),
    gitlab_list_commits: makeMethod(async (ctx, params) => {
      const { gitlabListCommits } = await import("./tools")
      return gitlabListCommits(ctx, params as Parameters<typeof gitlabListCommits>[1])
    }),
    gitlab_get_commit: makeMethod(async (ctx, params) => {
      const { gitlabGetCommit } = await import("./tools")
      return gitlabGetCommit(ctx, params as Parameters<typeof gitlabGetCommit>[1])
    }),
    gitlab_list_merge_requests: makeMethod(async (ctx, params) => {
      const { gitlabListMergeRequests } = await import("./tools")
      return gitlabListMergeRequests(ctx, params as Parameters<typeof gitlabListMergeRequests>[1])
    }),
    gitlab_get_merge_request: makeMethod(async (ctx, params) => {
      const { gitlabGetMergeRequest } = await import("./tools")
      return gitlabGetMergeRequest(ctx, params as Parameters<typeof gitlabGetMergeRequest>[1])
    }),
    gitlab_list_issues: makeMethod(async (ctx, params) => {
      const { gitlabListIssues } = await import("./tools")
      return gitlabListIssues(ctx, params as Parameters<typeof gitlabListIssues>[1])
    }),
    gitlab_list_milestones: makeMethod(async (ctx, params) => {
      const { gitlabListMilestones } = await import("./tools")
      return gitlabListMilestones(ctx, params as Parameters<typeof gitlabListMilestones>[1])
    }),
    gitlab_list_labels: makeMethod(async (ctx, params) => {
      const { gitlabListLabels } = await import("./tools")
      return gitlabListLabels(ctx, params as Parameters<typeof gitlabListLabels>[1])
    }),
    gitlab_list_releases: makeMethod(async (ctx, params) => {
      const { gitlabListReleases } = await import("./tools")
      return gitlabListReleases(ctx, params as Parameters<typeof gitlabListReleases>[1])
    }),
    gitlab_list_tags: makeMethod(async (ctx, params) => {
      const { gitlabListTags } = await import("./tools")
      return gitlabListTags(ctx, params as Parameters<typeof gitlabListTags>[1])
    }),
    gitlab_read_file: makeMethod(async (ctx, params) => {
      const { gitlabReadFile } = await import("./tools")
      return gitlabReadFile(ctx, params as Parameters<typeof gitlabReadFile>[1])
    }),
    gitlab_list_tree: makeMethod(async (ctx, params) => {
      const { gitlabListTree } = await import("./tools")
      return gitlabListTree(ctx, params as Parameters<typeof gitlabListTree>[1])
    }),
    gitlab_search: makeMethod(async (ctx, params) => {
      const { gitlabSearch } = await import("./tools")
      return gitlabSearch(ctx, params as Parameters<typeof gitlabSearch>[1])
    }),
  }
}
