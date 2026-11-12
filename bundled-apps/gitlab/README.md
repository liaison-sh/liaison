# GitLab — read-only GitLab connector

GitLab gives agents **read-only** access to a connected GitLab group: projects,
commits, merge requests, issues, milestones, labels, releases, tags, repository
files/tree, and search. It also syncs repository folders into the knowledge base
(knowledge source kind `folder`, config `{ ref: "<project>:<branch>:<path>" }`,
`src/knowledge.ts`), with their folders as collections. No write operations exist. When GitLab is not connected the tools surface a
`not_connected` error rather than fabricating data.

## Tools

All tools are scoped `gitlab:repo:read` and read-only:

| Tool | What it does |
|------|--------------|
| `gitlab_list_projects` | List projects in the group (call this first to discover ids/paths). |
| `gitlab_list_commits` / `gitlab_get_commit` | List/get commits (optionally with diff). |
| `gitlab_list_merge_requests` / `gitlab_get_merge_request` | List/get MRs (optionally with file changes). |
| `gitlab_list_issues` | List issues (filter by state/milestone/labels/search). |
| `gitlab_list_milestones` / `gitlab_list_labels` | List milestones / labels. |
| `gitlab_list_releases` / `gitlab_list_tags` | List releases / git tags. |
| `gitlab_read_file` / `gitlab_list_tree` | Read a file (secret-redacted) / list a repo path. |
| `gitlab_search` | Search blobs / commits / issues / merge_requests. |

## Connecting

Read [`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md) first —
it covers the shared machinery (credentials connections, ownership, egress
allowlisting). This section is the GitLab-specific runbook.

**Connection:** one `credentials` connection named `gitlab`. There is no OAuth —
the operator pastes a token. The app never reads it: every call goes through
`ctx.fetch` with the connection named, and the host adds the token as an
`Authorization: Bearer` header, only to `gitlab.com` and its subdomains (the
connection's `allowedDomains`), paced by the connection's `limits` (4 calls in
flight, 10 a second). Only the `group` field is readable by the app.

### What the connection needs, and where each part comes from

| Field | Required | Where it comes from |
|---|---|---|
| `token` | ✓ | A GitLab **Personal Access Token** (`glpat-…`) with **read-only** scopes — `read_api` **and** `read_repository`, **never** `api` (which grants write). Created on gitlab.com (steps below). Stored encrypted. |
| `group` | ✓ | The GitLab **group path or numeric id** the connector reads from (e.g. `my-group`). |

The connector calls only GET endpoints under `/api/v4` (projects, repository
files/tree, MRs, issues, milestones, releases, search), so `read_api` +
`read_repository` is the complete and minimal scope set — `api` is over-broad and
should not be granted.

### Provisioning steps

1. On gitlab.com, open your avatar → **Edit profile → Access tokens**
   (`gitlab.com/-/user_settings/personal_access_tokens`).
2. Create a token with scopes **`read_api`** and **`read_repository`** only —
   **not** `api`. Set a short expiry.
3. Copy the `glpat-…` value and paste it into the **token** field in
   Settings → GitLab.
4. In **group**, enter the group path or numeric id.

> On gitlab.com, *group* access tokens require Premium. A free **Personal Access
> Token** works identically here. For a non-personal token, create a free
> **Service Account** (group → Settings → Service accounts), add it as *Reporter*,
> and use its PAT.

**Ownership:** for a shared team GitLab token that agents must reach, connect it
**org-owned** (`mode: "org"`, needs `gitlab:accounts:admin`). A user-owned token
returns `not_connected` for everyone else — see the isolation note in the central
doc. A token belongs to whoever created it in GitLab regardless of ownership
here, so prefer a Service Account PAT for an org-owned connection.

### Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `not_connected` | no `gitlab` connection resolvable for the caller | Connect in Settings → GitLab; for a shared token connect **org-owned**. |
| `AUTH_REVOKED` (401) | token expired, revoked, or wrong | Regenerate the PAT (read_api + read_repository) and reconnect. |
| `FORBIDDEN` (403) | token lacks `read_api`/`read_repository`, or no access to that project/group | Re-issue the token with the read scopes; confirm the token's user/Service Account can see the group. |
| `NOT_FOUND` (404) | wrong `group`, or a project path/id that doesn't exist / isn't visible | Verify the group path/id and the project path; `gitlab_list_projects` first. |
| `RATE_LIMITED` (429) | GitLab rate limit hit | Honour `Retry-After` and retry. |
| "egress refused" | a redirect or configured base URL pointed off gitlab.com | Expected host-pinning guard — the connector only talks to the configured GitLab host. |
| Tool returns `not_connected` for some users only | connection is user-owned; caller/agent is a different user | Reconnect **org-owned** (`mode: "org"`, needs `gitlab:accounts:admin`). |

## Checking the connection

`liaison config verify` (and the check `config apply` runs after it applied the
connection) runs the app's `provisioning.verify` handler: one read of the token
owner's profile and of the connected group (`src/provisioning.ts`).

## Moving from the in-tree app

Releases before this one shipped GitLab inside the server. An instance that ran
it keeps its connection, credentials and synced folders: the catalog app is
installed under the same name and each synced folder becomes a `folder` source
with its reference as config (`apps/api/src/modules/apps/moved-apps.ts`), so its
documents keep their ids and folders.
