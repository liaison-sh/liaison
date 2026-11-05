---
title: GitLab
description: "Connect a gitlab.com group read-only so agents can read projects, issues, merge requests and releases, and sync repository docs into Knowledge."
---

GitLab gives your agents read-only access to one gitlab.com group: projects, commits, merge requests, issues, milestones, labels, releases, tags, files and search. It can also bring a repository's documentation into [Knowledge](knowledge.md). Nothing is ever written to GitLab.

## Connect a GitLab group

GitLab connects with a token you paste, not with OAuth.

1. On gitlab.com, open your avatar, then **Edit profile › Access tokens**.
2. Create a personal access token with the scopes `read_api` and `read_repository` only. Never grant `api`, which allows writes.
3. Set the longest expiry GitLab offers. An expired token stops every sync silently: the connection still looks configured while GitLab refuses it, and content goes stale.
4. In Liaison, open **Settings › Apps › GitLab**, section **Connection**, and click **Connect**. You need `gitlab:accounts:admin`.
5. Paste the `glpat-…` value into **GitLab group access token**, and enter the **GitLab group path or ID**, for example `resonant-audio-labs`.

To rotate the token later, open the same form and paste the new token. It replaces the stored one instead of adding a second connection.

Only gitlab.com is supported: the connection may reach `gitlab.com` and its subdomains only.

## Ask about your projects

Ask your agent, for example:

- "Which merge requests are open on the firmware project?"
- "Were all the bugs in milestone 2.3 closed before the 2.3 release?"
- "Show me the README of the mobile app repository."

The agent starts with `gitlab_list_projects` to find the project, then reads what it needs. File contents are redacted for secrets before the agent sees them.

## Bring repository docs into Knowledge

GitLab is a Knowledge source. Ask your agent to import a repository path, for example "Sync the docs folder of the manual repository into Knowledge". It uses `knowledge__add_folder_source` with the GitLab source, which creates one Knowledge document per file and can keep syncing on a schedule. The source then appears in **Settings › Apps › Knowledge › Synced sources**. See [Knowledge](knowledge.md#sync-a-google-drive-folder).

## Roles and scopes

| Role | Scopes |
|---|---|
| `member` | `gitlab:repo:read`, `gitlab:accounts:read` |
| `admin` | `member` plus `gitlab:accounts:admin` |

`gitlab:approve` decides any GitLab approvals. See the [scope reference](../reference/scopes.md) and [roles](../admin/roles.md).

## What agents can do

All tools are read-only and need `gitlab:repo:read`.

| Tool | What it does |
|---|---|
| `gitlab_list_projects` | List the projects in the connected group |
| `gitlab_list_commits` | List commits, filtered by branch, path or date |
| `gitlab_get_commit` | Get one commit, optionally with its diff |
| `gitlab_list_merge_requests` | List merge requests by state, branch, milestone or label |
| `gitlab_get_merge_request` | Get one merge request, optionally with its changes |
| `gitlab_list_issues` | List issues by state, milestone, label or text |
| `gitlab_list_milestones` | List milestones |
| `gitlab_list_labels` | List labels with issue and merge request counts |
| `gitlab_list_releases` | List releases with their milestone issue counts |
| `gitlab_list_tags` | List git tags |
| `gitlab_read_file` | Read a file at a branch, tag or commit |
| `gitlab_list_tree` | List files and folders at a path |
| `gitlab_search` | Search file contents, commits, issues or merge requests |

See the [agent tool reference](../reference/agent-tools.md).
