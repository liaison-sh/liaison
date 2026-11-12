---
title: GitHub
description: "Connect a GitHub organization or user read-only so agents can read repositories, commits, pull requests, issues and releases."
---

GitHub gives your agents read-only access to one GitHub organization or user: repositories, commits, pull requests, issues, milestones, labels, releases, tags, files and search. Nothing is ever written to GitHub.

## Connect GitHub

GitHub connects with a token you paste, not with OAuth.

1. On github.com, open your avatar, then **Settings › Developer settings › Personal access tokens › Fine-grained tokens**, and choose **Generate new token**.
2. Under **Resource owner**, pick the organization (or yourself), and under **Repository access** the repositories Liaison may read.
3. Under **Repository permissions**, set **Contents**, **Metadata**, **Pull requests** and **Issues** to **Read-only**. Leave everything else at No access.
4. Set the longest expiry your organization allows. An expired token stops every GitHub read until you paste a new one.
5. In Liaison, open **Settings › Apps › GitHub**, section **Connection**, and click **Connect**. You need `github:accounts:admin`.
6. Paste the `github_pat_…` value into the token field, and enter the organization or user name in **GitHub organization or user name**.

To rotate the token later, open the same form and paste the new token. It replaces the stored one.

A token that can write is refused. A classic token with the `repo` scope (or any other write or admin scope) gets `write_token_refused`, with the fix: create a fine-grained read-only token. GitHub does not show a fine-grained token's permissions, so keep it read-only yourself; `liaison config verify` reminds you.

## Ask about your repositories

Ask your agent, for example:

- "Which pull requests were merged on the website repository this week?"
- "What changed in the last commits on main?"
- "Show me the README of the mobile app repository."

The agent starts with `github_list_repos`, then reads what it needs. It reads only the connected owner's repositories: a repository of anyone else is refused. Every text it reads (files, diffs, commit messages, issue and pull request text, search results) is redacted for secrets before the agent sees it.

## Check the connection

`liaison config verify` checks the stored token with one read of its user and of the owner, and so does `liaison config apply` after it saved the connection. The token itself never leaves the server's connection store.

## Roles and scopes

| Role | Scopes |
|---|---|
| `member` | `github:repo:read`, `github:accounts:read` |
| `admin` | `member` plus `github:accounts:admin` |

`github:approve` decides any GitHub approvals. See the [scope reference](../reference/scopes.md) and [roles](../admin/roles.md).

## What agents can do

All tools are read-only and need `github:repo:read`.

| Tool | What it does |
|---|---|
| `github_list_repos` | List the owner's repositories |
| `github_list_commits` | List commits, filtered by branch, path, author or date |
| `github_get_commit` | Get one commit, optionally with its diff |
| `github_list_pull_requests` | List pull requests by state, base branch or last update |
| `github_get_pull_request` | Get one pull request, optionally with its changed files |
| `github_list_issues` | List issues by state, label, milestone or last update |
| `github_list_milestones` | List milestones with their issue counts |
| `github_list_labels` | List labels |
| `github_list_releases` | List releases |
| `github_list_tags` | List git tags |
| `github_read_file` | Read a file at a branch, tag or commit |
| `github_list_tree` | List files and folders at a path |
| `github_search` | Search code, commits, issues or pull requests |

Every read but `github_read_file` can feed a dashboard block. See the [agent tool reference](../reference/agent-tools.md).
