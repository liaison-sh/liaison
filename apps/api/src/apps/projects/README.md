# Projects — projects & tasks, with inbound CI release-status reporting

Projects tracks assignable work: projects (boards), per-project status columns,
and tasks with owners, priorities, due dates, and dependencies. Agents use it for
anything that needs an owner, a status, and a due date (a sales pipeline / deals
board is modelled here as a project whose tasks are the deals). It also accepts
**inbound** CI release-status deliveries: a CI system POSTs a signed release
status and Projects upserts a task for it.

## Tools (highlights)

| Tool | Scope | What it does |
|------|-------|--------------|
| `search` / `get` | `projects:projects:read` | Find projects/tasks; fetch one by id. |
| `create` (task) / `createProject` | `projects:*:write` | Create a task / a project board (neither gated). |
| `update` / `move` / `delete` / `merge` | `projects:tasks:write` | Edit, relocate, delete, merge tasks (`delete` and `merge` are gated; `update` and `move` apply at once). `create` and `update` take `labels`, a map of label group (name or id) to value (name or id), `null` clearing the task's own value; an unknown or archived value is refused with `label_not_found` / `label_archived`, naming the valid values. `bulkUpdate` with `operation: "setLabels"` applies the same map to many tasks. |
| `tasks_byProject` / `tasks_byAssignee` / `attentionItems` / `portfolio_rollup` | `projects:tasks:read` | Enumerate a board, one person's work, your own attention items, or a cross-project rollup. Every task row carries `labels` (effective value per group, flagged `inherited` with `inheritedFromKey`). `tasks_byProject` also takes a `labels` filter (one value per group, AND across groups, `__none__` for no value) and `completedAfter` / `completedBefore` (inclusive / exclusive) which, with `terminal: true` and `countOnly: true`, return the completed count in `totalCount`. |
| `status_add` / `status_update` / `status_delete` | `projects:projects:write` | Manage a board's status columns (`status_delete` is gated; adding and renaming apply at once). |
| `checklist_get` / `checklist_add_items` / `checklist_update_item` / `checklist_set_validation` / `checklist_remove_item` | `projects:tasks:*` | Read and edit a task's checklist and its per-level validations; removal is gated. The checklist never blocks a status change; an agent that moves a task with an incomplete checklist to a terminal status gets `checklistWarning`: in the `move` or `update` result, or on each item of a `bulkUpdate` result. |
| `labels.list` / `labels.tree` | `projects:projects:read` | List the org's task label groups and values (`includeArchived` adds archived ones), or the live tree the Settings page loads. |
| `labels.create` / `labels.update` / `labels.archive` / `labels.reorder` | `projects:labels:admin` | Admin writes on the label taxonomy: create a group or value, rename or reorder, archive or restore (`archived: false`), save the whole tree (`labels.reorder`, refused with `conflict` on a stale `baseVersion`). A value never moves to another group. |
| `webhook_info` | `projects:settings:admin` | Operator read: whether the CI webhook secret is minted, and its value. Not agent-visible. |

## Connecting

Read [`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md) first —
it covers the shared machinery (credentials connections, ownership). This section
is Projects-specific. Note the direction is inverted from the OAuth connectors:
Projects **never calls out** to the CI system. The connection exists so the
kernel **mints an HMAC signing secret**, and the CI system POSTs **inbound** to
Liaison, signing each delivery with that secret.

**Connection:** one `credentials` connection named `ci-source`. `allowedDomains`
is empty — there is no outbound egress. On connect the kernel mints a random
signing secret and stores it under the config key `ciWebhookSecret`
(`webhookSecretConfigKey`), reusing it on reconnect.

### What the connection needs, and where each part comes from

| Field / value | Where it comes from |
|---|---|
| `label` (required) | Operator-entered — a name for the reporting CI system (e.g. `teamcity-prod`, `gitlab-orders-api`). |
| `projectName` (optional) | Operator-entered — the project that release-status tasks land in (created if absent). |
| **Signing secret** | **Kernel-minted** on first connect (not operator-supplied). Read it back with the `webhook_info` tool (admin scope), which returns `{ configured, secret, signatureHeader: "x-projects-ci-signature", algorithm }`. The CI system signs with this. |
| **Webhook URL** | Not stored on the connection — it is the kernel's generic inbound endpoint: `${BASE_URL}/webhooks/<orgId>/projects/ci-status`. |

### Provisioning steps

1. In Settings, connect **`ci-source`**: enter a `label` (and optionally a
   `projectName`) and connect. The kernel mints the signing secret.
2. Read the secret with the **`webhook_info`** tool (admin scope,
   `projects:settings:admin`). It returns the secret plus the header name and
   algorithm.
3. Configure the CI system (a TeamCity build-status notifier, or a GitLab
   pipeline-hook relay) to **POST a release-status JSON envelope** to
   `${BASE_URL}/webhooks/<orgId>/projects/ci-status`.
4. Sign the **raw request body** with **HMAC-SHA256**, base64-encode the digest,
   and send it in the **`x-projects-ci-signature`** header. Optionally set a
   stable `x-projects-ci-delivery-id` header for replay-dedup (otherwise a hash
   of the body is used).
5. Include a fresh **`ts`** (ISO-8601 or epoch ms) in every payload — it is
   covered by the signature; deliveries whose signed `ts` is outside the
   freshness window are rejected (default **600 s / 10 min**; override via the
   `ciWebhookTtlSeconds` config key).
6. Include a stable **`externalRef`** per release/pipeline run (e.g.
   `teamcity:<buildTypeId>:<buildNumber>` or the GitLab pipeline id). Repeat
   deliveries for the same `externalRef` **update the same task** instead of
   creating duplicates.

**Ownership:** `ci-source` is an org-level operational connection — connect it
**org-owned** so the minted secret and the ingested tasks belong to the org, not
one user. Managing it needs `projects:settings:admin`.

### Failure modes (verifier `reason` → HTTP)

| Symptom / verifier reason | Cause | Fix |
|---|---|---|
| `404 Unknown webhook endpoint` | wrong URL — bad `orgId`, app name, or endpoint | POST to exactly `${BASE_URL}/webhooks/<orgId>/projects/ci-status`. |
| `missing_secret` | the `ci-source` connection was never established (no secret minted) | Connect `ci-source` in Settings, then read `webhook_info`. |
| `missing_signature` | no `x-projects-ci-signature` header | Sign the raw body and send the header. |
| `signature_mismatch` | signed with the wrong secret, or the body was altered/re-encoded in transit | Sign the exact raw bytes with the secret from `webhook_info` (HMAC-SHA256, base64). |
| `missing_ts` | no `ts` field in the payload | Include a `ts` (ISO-8601 or epoch ms) in every delivery. |
| `stale_ts` / `future_ts` | `ts` older/newer than the freshness window | Send a fresh `ts`; fix CI clock skew, or widen `ciWebhookTtlSeconds`. |
| `413 Payload too large` | body over the 64 KB endpoint cap | Trim the payload. |
| `503 ci-status processing failed` | transient error (e.g. DB blip) after a valid signature | The kernel releases the replay claim so the CI side's retry re-delivers — retry. |
