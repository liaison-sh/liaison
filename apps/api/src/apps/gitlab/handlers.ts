// SPDX-License-Identifier: FSL-1.1-ALv2
// GitLab connector — sandboxed manifest handler bundle.
//
// GitLab is a headless connector. Its agent tools are thin sandboxed handlers
// that delegate to host-side bridge methods (`gitlab_*`), where credential
// resolution and REST calls happen with host privileges. Mirrors the Drive
// handler ↔ bridge split.
//
// biome-ignore-all lint/correctness/noUnusedVariables: handlers resolved by manifest export name

// Type-only import forces TypeScript to treat this file as a module so its
// top-level function names don't collide with another app's handlers in the
// shared global type scope. Bun strips it at bundle time; the QuickJS runtime
// still sees script-mode source where the declarations auto-promote to global.
import type {} from "node:buffer"

interface GitlabSandboxCtx {
  gitlab_list_projects: (paramsJson: string) => Promise<string>
  gitlab_list_commits: (paramsJson: string) => Promise<string>
  gitlab_get_commit: (paramsJson: string) => Promise<string>
  gitlab_list_merge_requests: (paramsJson: string) => Promise<string>
  gitlab_get_merge_request: (paramsJson: string) => Promise<string>
  gitlab_list_issues: (paramsJson: string) => Promise<string>
  gitlab_list_milestones: (paramsJson: string) => Promise<string>
  gitlab_list_labels: (paramsJson: string) => Promise<string>
  gitlab_list_releases: (paramsJson: string) => Promise<string>
  gitlab_list_tags: (paramsJson: string) => Promise<string>
  gitlab_read_file: (paramsJson: string) => Promise<string>
  gitlab_list_tree: (paramsJson: string) => Promise<string>
  gitlab_search: (paramsJson: string) => Promise<string>
}

async function gitlabListProjects(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_list_projects(JSON.stringify(params ?? {})))
}

async function gitlabListCommits(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_list_commits(JSON.stringify(params ?? {})))
}

async function gitlabGetCommit(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_get_commit(JSON.stringify(params ?? {})))
}

async function gitlabListMergeRequests(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_list_merge_requests(JSON.stringify(params ?? {})))
}

async function gitlabGetMergeRequest(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_get_merge_request(JSON.stringify(params ?? {})))
}

async function gitlabListIssues(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_list_issues(JSON.stringify(params ?? {})))
}

async function gitlabListMilestones(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_list_milestones(JSON.stringify(params ?? {})))
}

async function gitlabListLabels(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_list_labels(JSON.stringify(params ?? {})))
}

async function gitlabListReleases(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_list_releases(JSON.stringify(params ?? {})))
}

async function gitlabListTags(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_list_tags(JSON.stringify(params ?? {})))
}

async function gitlabReadFile(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_read_file(JSON.stringify(params ?? {})))
}

async function gitlabListTree(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_list_tree(JSON.stringify(params ?? {})))
}

async function gitlabSearch(params: unknown, ctx: GitlabSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.gitlab_search(JSON.stringify(params ?? {})))
}
