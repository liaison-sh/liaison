---
title: Projects
description: "Plan work in Projects: create projects and tasks, move them across a board, track checklists and releases, and let agents keep tasks up to date."
screenshot: "assets/screens/projects.webp"
screenshotAlt: "The Projects overview listing four active projects with their task counts, and filters for status and due date in the sidebar."
---

Projects holds your team's work as projects and tasks on a board. You create tasks, move them between status columns, discuss them, and track checklists and releases. Agents can create and update tasks and summarise where every project stands.

## Create a project

1. Click **Projects** in the activity bar.
2. Click **New project**.
3. Enter a **Project name** and, optionally, a **Description (optional)**.
4. In **Columns (optional)**, type the board columns comma-separated, in board order, or leave it empty for the default columns. The last column counts as done.
5. Pick an **Icon** and a **Color**, then click **Create project**.

To change a project, open its actions and click **Edit project**. Its name, key, description, group, icon and colour are edited in place, in the project header; click **Save**. The key is the prefix of every task key (ERB in ERB-12), so it can change only while the project has no task: once it has one, even in the trash, the key is read-only. The project list in the sidebar shows each project's key before its name.

To sort a long project list, give projects a **Group (optional)** in **Edit project**, such as Product or Legal: up to 60 characters, and the groups already in use are suggested as you type. Projects with the same group sit under one heading in the sidebar. Projects without a group come first, with no heading, then the groups in alphabetical order. Click a group's heading to fold or unfold it; this device remembers which groups you folded, for you in this organization (someone else signing in on the same device starts with every group open). Empty the field to take a project out of its group. Archived projects stay in **Archived**, without groups.

To retire a project, open its actions and click **Archive project**. Its tasks are kept, and you can restore it from **Archived** in the sidebar with **Restore project**.

## Add tasks

1. Open a project and click **New task**, or type in **New task… (Enter to create)** at the bottom of the list.
2. In the dialog, enter a **Title** ("What needs doing?"), a **Description** (Markdown is supported) and a **Status**. The default is the first status.
3. Click **Create**.

Switch between **List view** and **Kanban view**. On the board, drag a card to another column to change its status.

## Work on a task

Open a task to set its **Assignee** (or **Assign to me**), **Due date**, **Priority**, **Release** (**Add release**) and whether it is **Blocked**. A task can have subtasks.

- **Discussion**: write in **Add a comment… (Cmd+Enter to send)** and click **Comment**. **Promote to thread list** adds the task's discussion to your [chat](chat.md) sidebar.
  Type `@` to bring an agent into the discussion. Its answer shows there as it works, the same as in a chat: **Working** while it runs, each tool it uses, and any approval it asks for, inline.
  A notification about a comment names the task (**Task:** followed by its title and project) and opens the task on that comment. A task you cannot see shows **Task not found**.
- **Linked documents**: mention a Knowledge document or a Drive spec in the description with `#`, or attach a file. The person who attached a file, or a projects administrator (`projects:settings:admin`), can remove it from the task: click its remove button, then confirm. A file posted with a comment goes with that comment.
- **Checklist**: track the steps or acceptance criteria of the task.
- **Copy task key** copies the task's short key.
- Under the key, **Created by** names who created the task and when. When an agent created it, the line names the agent (or the routine) instead of the person it acted for.

**Copy link** (on a task, and in a project's actions menu) copies the page's address. Paste it in a message or a task description and it becomes a chip that opens the project or task; it never notifies anyone.

To delete a task, click **Delete task**. Deleted tasks go to the project's **Trash**, where **Put back** restores them. A pending request to change a deleted task (an agent's request to delete it, for example) is cancelled, and the card tells the person who asked why; **Put back** makes it pending again.

## Follow deals on a pipeline

A sales pipeline is a project whose board shows deals. Under its name, a line counts the open deals and their total, for example "9 open deals, €68,660. Quiet deals come first in each column." Click **New deal** to add one.

- Each column shows its stage, one sum per currency (two currencies are never added together) and its number of deals. **Won** and **Lost** show only the deals closed this month, as **Won this month** and **Lost this month**.
- A card shows the deal's key and title, its company, the amount, the owner's initials, **Next:** and the next step, and **Quiet for N days** since the last mail. The quietest deals come first in an open column; no colour marks them.
- Without deal access (`projects:deals:read`) the sums are hidden and a card reads **Needs deal access**. A reader who cannot read mail sees no quiet line.
- The routine template `deal-followups` drafts a follow-up for each quiet open deal from the deal owner's own mailbox; a deal whose owner's mailbox you cannot send from is skipped and named in the run's summary. See [Routines](../agents/routines.md).
- Drag a card to another stage: a line at the top of the board says where it went, with **Undo**. After a move to **Lost**, type the reason in **Why was it lost? (optional)**; it is saved when you leave the field. If the move fails, the card goes back and **Projects did not answer. No deal was moved.** shows.

Open a deal to see the **Deal** panel above its description: **Amount**, **Company**, **Contact** and **Next step**, with **Mark won**, **Mark lost** (with an optional reason) and **Reopen**. These buttons show only with `projects:deals:write`. If the deal cannot be read, the panel says **Could not read the deal. The task below is not affected.** and the task page works as usual.

To name a project's client, open **Edit project**, search in **Client (optional)** and pick the company; **Clear the client** removes it.

## Find tasks

1. In the Projects sidebar, type in **Search tasks…**. From a task, the search and every filter bring that task's project list forward (it opens if it was closed); the task stays open in its tab.
2. Filter with **Assigned to me** and **Due** (**Overdue**, **Due soon**, **Later**, **No due date**).
3. If your organisation has label groups, filter with **Labels** (see [Filter tasks by label](#filter-tasks-by-label)).
4. To get back to what you were working on, turn on **Recently involved** (see [Find the tasks you worked on](#find-the-tasks-you-worked-on)).

The default saved views are **My tasks**, **Due this week** and **Recently involved** on the Projects home, and **Active tasks** and **Recently involved** in a project.

## Find the tasks you worked on

**Recently involved** in the Projects sidebar lists the tasks you took part in over the last 14 days, the most recent first. On the Projects home it covers every project; in a project, only that project. A task is on the list when, in that window:

- you commented on its discussion, or someone mentioned you there;
- you changed its status, its assignee or another field, or moved it;
- you created it;
- someone assigned it to you, or it is assigned to you and changed.

Each row says why, for example "You moved it to Done · 2 hours ago" or "Riley mentioned you · 3 days ago". The other filters still apply on top. A saved view keeps the filter with its window, up to 90 days. A task you can no longer see, a deleted task or a task of an archived project never appears.

To change many tasks at once, select them and use **Change status…**, **Move…**, **Assign…** or **Set labels…**.

## Label tasks

Labels sort your tasks along axes your organisation chooses, such as Nature (bug, evolution, maintenance, support) or Domain. An admin defines each axis as a label group and its choices as values (see [Manage labels](#manage-labels)). A task holds at most one value per group.

1. Open a task. Each group shows as a chip in the task's header row, for example **Nature: bug**.
2. Click the chip and pick a value from the list. A group with no value on the task reads **Nature: not set**.
3. To remove the task's own value, click the chip and pick **None**.

A subtask shows its parent's value, in italics, until you give it its own. Hover the chip to see **Inherited from** the parent's task key. A value you set on the subtask replaces the inherited one for that group only. Clearing it brings the inherited value back.

On the Kanban view, each card shows its labels as small chips. When there are too many to fit, the last chip shows how many more there are (for example **+2**), and hovering it lists them.

An archived value stays on the tasks that already have it and reads **bug (archived)**. You cannot assign it to another task. If a group is archived, its chip offers no values to pick (**This group is archived**): you can only clear the task's own value with **None**, and an inherited value is read-only.

To label many tasks at once, select them and click **Set labels…**. The form has one list per group. Leave a group on **Unchanged** to keep each task's value, pick a value to set it, or pick **None** to clear it, then click **Set labels**. If no label group exists, the form says **No label groups**.

If your organisation has no label group, no label chip and no **Labels** filter appear.

## Filter tasks by label

1. In a project, click **Labels** in the filter bar (on a phone, open the project menu and click **Filter by label**).
2. Under each group, pick one value. Pick it again to unpick it. Picking values in several groups keeps only the tasks that match all of them.
3. Pick **No label** under a group to see the tasks with no value in that group.
4. The button then reads **Labels · 2** (the number of groups in use). Click the clear control (**Clear label filter**) to remove the filter.

The filter matches the value a task shows, including a value inherited from its parent. Archived values stay in the list, marked **(archived)**, so you can still find old work. The label filter is saved with a saved view, and it also works on the Projects home across all projects.

## Customise statuses and checklist levels

1. In a project, open **Manage statuses**.
2. Click **Add status**, rename or delete a column, and tick **Counts as done** for terminal columns. A column must be empty before you can delete it.
3. Under **Checklist validations**, add the levels a checklist item must pass, such as a review step. Without levels, each item is a simple checkbox. A project can have at most 8 levels.

## Manage labels

You need `projects:labels:admin` (the `admin` role has it).

1. Open **Settings › Apps › Projects**, section **Labels**.
2. Click **+ Add** to add a group, then use **Add inside** on it to add its values. Use **Rename** to rename either, drag to reorder values within a group, and **Archive** to retire one.
3. Click **Save**. The whole tree saves at once. If someone else saved first, the page says **Changed by someone else. Reload to see it.**; click **Reload**, then redo your change.

Names are 1 to 60 characters and unique within their group, ignoring case. A value cannot move to another group: create a new value there instead. Groups and values have only two levels.

Archiving a group archives its values with it. Archived labels leave the Settings tree, so you restore one through an agent: `labels.archive` with `archived: false`. Restoring a group brings back its values.

## Report CI release status into a project

A CI system such as TeamCity or GitLab can report build and release status into a project through a signed webhook.

1. Open **Settings › Apps › Projects**, section **CI release status**. You need `projects:settings:admin`.
2. Connect with a **CI system label (e.g. teamcity-prod)** and, optionally, the **Project name for release-status tasks (created if absent)**. Connecting creates the webhook signing secret.
3. An agent with the admin scope can read the secret with `webhook_info`.
4. Configure the CI system to POST a release-status JSON payload to the projects app's `ci-status` webhook, signed with HMAC-SHA256 (base64) in the `x-projects-ci-signature` header. Each payload needs a fresh `ts` (deliveries older than 10 minutes are rejected; change it with the `ciWebhookTtlSeconds` config key) and an `externalRef`, so repeat deliveries update the same task.

## Import projects and tasks

Tasks import as the `projects.task` kind (matched on `externalRef`; the project and status are found by name or created), projects as the `projects.project` kind (matched on name, with their statuses). Importing tasks needs `projects:tasks:write` and `projects:projects:write`. Each import is a run you can undo from **Settings › Organization › Imports** (see [Undo an import](../admin/settings.md#undo-an-import)).

A task record can carry its attachments (`attachments`: a file name, its type and the id of an uploaded file, with the date and the author's email when known): each is stored as a file of the task, dated and attributed like the original. A task record can carry its checklist (`checklist`: items with a title, details and whether they are checked) and its dependencies (`dependsOn`: the `externalRef` of the task it waits on, and `blocks` or `relates`). A dependency on a task the run brings later is linked once all the run's tasks are in; one whose task never arrives, or that you cannot see, is counted as unresolved and the task still imports.

A preview of a task import runs the same checks as the run, without writing anything: a task whose parent is neither imported nor earlier in the import, a comment with a date that cannot be read, or an attachment of a refused file type is counted as refused before anyone approves the run.

Project templates import as the `projects.template` kind: a name and its task tree (`structure`: tasks with a title, a description and child tasks, at most eight levels deep). A template whose name exists is skipped. Importing templates needs `projects:settings:admin`.

## Attach files to imported tasks

After you import tasks with `liaison projects import`, attach their original files from a local folder:

```
liaison projects attach-files --file <ndjson> --files-dir <dir> [--org <slug>] [--dry-run] [--placeholder-unknown-users]
```

Each file is matched to its task by `externalRef`, backdated, and kept under its original uploader. Nobody is notified. Every file path in the NDJSON is relative to `--files-dir` and may not leave it. A re-run skips files already attached. Add `--dry-run` to check the batch first. An unknown uploader email fails the batch unless you pass `--placeholder-unknown-users`, which creates a deactivated user for it. See the [CLI reference](../reference/cli.md#projects-attach-files).

## Roles and scopes

| Role | Scopes |
|---|---|
| `member` | `projects:projects:read`, `projects:tasks:read`, `projects:tasks:write` |
| `sales` | `member` plus `projects:deals:read` and `projects:deals:write` (deal amounts) |
| `lead` | `member` plus `projects:projects:write`, `projects:deals:read` and `projects:deals:write` |
| `admin` | `lead` plus `projects:settings:admin` and `projects:labels:admin` |

`projects:approve` decides the approvals gated project tools raise. See the [scope reference](../reference/scopes.md) and [roles](../admin/roles.md).

## What agents can do

| Tool | What it does | Approval |
|---|---|---|
| `search`, `get` | Find and read projects and tasks. `search` with `involvedWithinDays` (1 to 90) returns only the tasks you were recently involved in, each with the reason. `search` leaves deleted tasks out unless you ask for them with `archived`, and marks them when they are included | No |
| `createProject` | Create a project with up to 20 tasks | No |
| `update_project` | Edit a project's name, description, group, icon, colour or key (the key only while the project has no task) | No |
| `instantiate_template` | Create a project from a stored template | No |
| `create` | Create a task in a project | No |
| `update` | Update a task | No |
| `move` | Move a task within or between projects | No |
| `delete` | Delete a task and its subtasks (to the trash) | Yes |
| `merge` | Merge one task into another | Yes |
| `add_dependency` | Make one task block another | No |
| `tasks_byAssignee`, `tasks_byProject`, `attentionItems`, `portfolio_rollup` | Task lists per person or project, your overdue and blocked work, a cross-project rollup | No |
| `deals_pipeline_create`, `deals_search`, `deals_update`, `deals_rollup`, `deals_followup_candidates` | Create a sales pipeline, find and change deals, and sum them per stage, owner or month. See [Track deals on a pipeline](../sales/deals.md) | No |
| `comment`, `comments` | Write and read a task's discussion | No |
| `status_add`, `status_update` | Add or change a status column | No |
| `status_delete` | Delete an empty status column | Yes |
| `checklist_get`, `checklist_add_items`, `checklist_update_item`, `checklist_set_validation` | Read and edit checklists and record validations | No |
| `checklist_remove_item` | Remove a checklist item | Yes |
| `labels.list` | List the label groups and their values (`includeArchived` adds archived ones) | No |
| `labels.create`, `labels.update`, `labels.archive` | Create, rename, reorder, archive or restore a label group or value (needs `projects:labels:admin`) | No |
| `webhook_info` | Read the CI webhook setup | No |

To label a task, an agent passes `labels` to `create` or `update`: a map of group name to value name, such as `{"Nature": "bug"}`. `null` clears the task's own value, and groups left out are untouched. A name that does not exist, an archived value, or a value of another group refuses the whole call with `label_not_found` or `label_archived`, and the message lists the valid values. `bulkUpdate` with `operation: "setLabels"` does the same for many tasks. Every task an agent reads carries `labels`, with whether each value is inherited and from which task key.

`tasks_byProject` takes a `labels` filter (one value per group, `__none__` for no value). With `terminal: true`, `completedAfter` (inclusive), `completedBefore` (exclusive) and `countOnly: true`, `totalCount` is the number of tasks of the project completed in that window with that label. Call it once per value and week for a weekly count.

In a task's discussion, the agent knows which task the conversation is about: its key, title and project. Ask it there to break the task into subtasks and it files them under that task.

See the [agent tool reference](../reference/agent-tools.md).
