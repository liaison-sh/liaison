// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Host-side agent-tool logic for the GitLab connector.
 *
 * Each function takes a `GitlabToolCtx` (injected by the bridge) and typed
 * params, makes the appropriate `GitlabClient` calls, and returns a compact
 * agent-friendly result. Error detail is surfaced from the real HTTP response
 * — never the token or request init.
 *
 * Secret redaction is applied to file content in `gitlabReadFile`.
 */

import type { RlsClient } from "~/db"
import { redactSecrets } from "./adapter"
import { GitlabHttpError, makeGitlabFetchers } from "./gitlab-rest"

export interface GitlabToolCtx {
  tx: RlsClient
  orgId: string
  userId: string
  /** `null` when no GitLab connection exists. */
  creds: { token: string; group: string } | null
}

export type GitlabToolError = { error: { code: string; message: string } }
export type GitlabToolResult<T> = T | GitlabToolError

export const NOT_CONNECTED: GitlabToolError = {
  error: {
    code: "not_connected",
    message: "No GitLab connection for this organization.",
  },
}

function mapError(err: unknown): GitlabToolError {
  if (err instanceof GitlabHttpError) {
    return {
      error: {
        code: err.code ?? `HTTP_${err.status}`,
        message: err.gitlabMessage ?? err.message,
      },
    }
  }
  return {
    error: {
      code: "TOOL_ERROR",
      message: err instanceof Error ? err.message : "GitLab tool failed",
    },
  }
}

function makeClient(token: string) {
  return makeGitlabFetchers(async () => token)
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function gitlabListProjects(
  ctx: GitlabToolCtx,
  _params: Record<string, never>,
): Promise<GitlabToolResult<{ projects: unknown[] }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const projects = await client.listProjects({ groupId: ctx.creds.group })
    return {
      projects: projects.map((p) => ({
        id: p.id,
        path: p.path_with_namespace,
        url: p.web_url,
        defaultBranch: p.default_branch,
      })),
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabListCommits(
  ctx: GitlabToolCtx,
  params: { project: string; ref?: string; path?: string; since?: string; until?: string },
): Promise<GitlabToolResult<{ commits: unknown[] }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const commits = await client.listCommits({
      projectId: params.project,
      ref: params.ref,
      path: params.path,
      since: params.since,
      until: params.until,
    })
    return {
      commits: commits.map((c) => ({
        sha: c.id,
        shortSha: c.short_id,
        title: c.title,
        message: c.message,
        author: c.author_name,
        date: c.committed_date,
        url: c.web_url,
        parents: c.parent_ids,
      })),
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabGetCommit(
  ctx: GitlabToolCtx,
  params: { project: string; sha: string; withDiff?: boolean },
): Promise<GitlabToolResult<{ commit: unknown }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const commit = await client.getCommit({
      projectId: params.project,
      sha: params.sha,
      withDiff: params.withDiff,
    })
    return {
      commit: {
        sha: commit.id,
        shortSha: commit.short_id,
        title: commit.title,
        message: commit.message,
        author: commit.author_name,
        date: commit.committed_date,
        url: commit.web_url,
        parents: commit.parent_ids,
        stats: commit.stats,
        diffs: commit.diffs,
      },
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabListMergeRequests(
  ctx: GitlabToolCtx,
  params: {
    project: string
    state?: string
    target_branch?: string
    milestone?: string
    labels?: string
    updated_after?: string
  },
): Promise<GitlabToolResult<{ mergeRequests: unknown[] }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const mrs = await client.listMergeRequests({
      projectId: params.project,
      state: params.state,
      target_branch: params.target_branch,
      milestone: params.milestone,
      labels: params.labels,
      updated_after: params.updated_after,
    })
    return {
      mergeRequests: mrs.map((mr) => ({
        iid: mr.iid,
        title: mr.title,
        description: mr.description,
        state: mr.state,
        targetBranch: mr.target_branch,
        sourceBranch: mr.source_branch,
        author: mr.author.username,
        assignees: mr.assignees.map((a) => a.username),
        milestone: mr.milestone?.title ?? null,
        labels: mr.labels,
        createdAt: mr.created_at,
        updatedAt: mr.updated_at,
        mergedAt: mr.merged_at,
        url: mr.web_url,
      })),
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabGetMergeRequest(
  ctx: GitlabToolCtx,
  params: { project: string; iid: number; withChanges?: boolean },
): Promise<GitlabToolResult<{ mergeRequest: unknown }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const mr = await client.getMergeRequest({
      projectId: params.project,
      iid: params.iid,
      withChanges: params.withChanges,
    })
    return {
      mergeRequest: {
        iid: mr.iid,
        title: mr.title,
        description: mr.description,
        state: mr.state,
        targetBranch: mr.target_branch,
        sourceBranch: mr.source_branch,
        author: mr.author.username,
        assignees: mr.assignees.map((a) => a.username),
        milestone: mr.milestone?.title ?? null,
        labels: mr.labels,
        createdAt: mr.created_at,
        updatedAt: mr.updated_at,
        mergedAt: mr.merged_at,
        url: mr.web_url,
        changes: mr.changes,
      },
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabListIssues(
  ctx: GitlabToolCtx,
  params: {
    project: string
    state?: string
    milestone?: string
    labels?: string
    search?: string
    updated_after?: string
  },
): Promise<GitlabToolResult<{ issues: unknown[] }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const issues = await client.listIssues({
      projectId: params.project,
      state: params.state,
      milestone: params.milestone,
      labels: params.labels,
      search: params.search,
      updated_after: params.updated_after,
    })
    return {
      issues: issues.map((i) => ({
        iid: i.iid,
        title: i.title,
        description: i.description,
        state: i.state,
        labels: i.labels,
        milestone: i.milestone?.title ?? null,
        author: i.author.username,
        assignees: i.assignees.map((a) => a.username),
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        closedAt: i.closed_at,
        url: i.web_url,
      })),
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabListMilestones(
  ctx: GitlabToolCtx,
  params: { project: string; state?: string },
): Promise<GitlabToolResult<{ milestones: unknown[] }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const milestones = await client.listMilestones({
      projectId: params.project,
      state: params.state,
    })
    return {
      milestones: milestones.map((m) => ({
        iid: m.iid,
        title: m.title,
        description: m.description,
        state: m.state,
        startDate: m.start_date,
        dueDate: m.due_date,
        url: m.web_url,
        issueStats: m.issue_stats,
      })),
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabListLabels(
  ctx: GitlabToolCtx,
  params: { project: string },
): Promise<GitlabToolResult<{ labels: unknown[] }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const labels = await client.listLabels({ projectId: params.project, withCounts: true })
    return {
      labels: labels.map((l) => ({
        name: l.name,
        color: l.color,
        description: l.description,
        openIssues: l.open_issues_count,
        closedIssues: l.closed_issues_count,
        openMRs: l.open_merge_requests_count,
      })),
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabListReleases(
  ctx: GitlabToolCtx,
  params: { project: string },
): Promise<GitlabToolResult<{ releases: unknown[] }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const releases = await client.listReleases({ projectId: params.project })
    return {
      releases: releases.map((r) => ({
        tagName: r.tag_name,
        name: r.name,
        description: r.description,
        createdAt: r.created_at,
        releasedAt: r.released_at,
        author: r.author?.username ?? null,
        milestones: (r.milestones ?? []).map((m) => ({
          title: m.title,
          iid: m.iid,
          issueStats: m.issue_stats,
        })),
        assetCount: r.assets?.count,
      })),
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabListTags(
  ctx: GitlabToolCtx,
  params: { project: string },
): Promise<GitlabToolResult<{ tags: unknown[] }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const tags = await client.listTags({ projectId: params.project })
    return {
      tags: tags.map((t) => ({
        name: t.name,
        message: t.message,
        commit: {
          sha: t.commit.id,
          title: t.commit.title,
          date: t.commit.committed_date,
        },
        release: t.release
          ? { tagName: t.release.tag_name, description: t.release.description }
          : null,
      })),
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabReadFile(
  ctx: GitlabToolCtx,
  params: { project: string; path: string; ref?: string; startLine?: number; endLine?: number },
): Promise<GitlabToolResult<{ content: string; url: string; ref: string }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const fileInfo = await client.getFile({
      projectId: params.project,
      path: params.path,
      ref: params.ref ?? "HEAD",
    })

    let text = Buffer.from(fileInfo.content, "base64").toString("utf-8")
    text = redactSecrets(text)

    // Apply line range if requested
    if (params.startLine !== undefined || params.endLine !== undefined) {
      const lines = text.split("\n")
      const start = params.startLine ?? 1
      const end = params.endLine ?? lines.length

      // Validate bounds
      if (start > end) {
        return {
          error: {
            code: "INVALID_PARAMS",
            message: `startLine (${start}) must be ≤ endLine (${end})`,
          },
        }
      }
      if (start > lines.length) {
        return {
          error: {
            code: "INVALID_PARAMS",
            message: `startLine (${start}) exceeds file length (${lines.length} lines)`,
          },
        }
      }

      // Lines are 1-based, array is 0-based
      text = lines.slice(start - 1, end).join("\n")
    }

    // Build permalink. `params.project` may be a numeric id (the manifest allows
    // "Project path or numeric ID"), which is NOT a valid namespace slot — resolve
    // `path_with_namespace` for a clickable URL, mirroring the adapter. Fall back
    // to `params.project` only if the lookup fails.
    let namespace = params.project
    try {
      const project = await client.getProject({ projectId: params.project })
      namespace = project.path_with_namespace
    } catch {
      // Keep the supplied project ref as a best-effort fallback.
    }
    const url = `https://gitlab.com/${namespace}/-/blob/${fileInfo.last_commit_id}/${params.path}`

    return {
      content: text,
      url,
      ref: fileInfo.last_commit_id,
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabListTree(
  ctx: GitlabToolCtx,
  params: { project: string; path?: string; ref?: string; recursive?: boolean },
): Promise<GitlabToolResult<{ entries: unknown[]; nextCursor?: string }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const { items, nextCursor } = await client.listTree({
      projectId: params.project,
      ref: params.ref ?? "HEAD",
      path: params.path ?? "",
      recursive: params.recursive ?? false,
    })
    return {
      entries: items.map((e) => ({
        name: e.name,
        path: e.path,
        type: e.type,
        id: e.id,
      })),
      nextCursor,
    }
  } catch (err) {
    return mapError(err)
  }
}

export async function gitlabSearch(
  ctx: GitlabToolCtx,
  params: { project?: string; scope: string; query: string; ref?: string },
): Promise<GitlabToolResult<{ results: unknown[] }>> {
  if (!ctx.creds) return NOT_CONNECTED
  try {
    const client = makeClient(ctx.creds.token)
    const results = await client.search({
      projectId: params.project,
      groupId: params.project ? undefined : ctx.creds.group,
      scope: params.scope,
      query: params.query,
      ref: params.project ? params.ref : undefined,
    })
    return {
      results: results.map((r) => ({
        path: r.path,
        filename: r.filename,
        ref: r.ref,
        snippet: r.data,
        startLine: r.startline,
        projectId: r.project_id,
      })),
    }
  } catch (err) {
    return mapError(err)
  }
}
