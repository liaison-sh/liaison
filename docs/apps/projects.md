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

Open a task to set its **Assignee** (or **Assign to me**), **Due date**, **Priority**, **Release** (**Add release**) and whether it is **Blocked**. A task shows its status by name and its due date in one date style. A task can have subtasks.

- **Discussion**: write in **Add a comment… (Cmd+Enter to send)** and click **Comment**. **Promote to thread list** adds the task's discussion to your [chat](chat.md) sidebar.
  Type `@` to bring an agent into the discussion. Its answer shows there as it works, the same as in a chat: **Working** while it runs, each tool it uses, and any approval it asks for, inline.
  A notification about a comment names the task (**Task:** followed by its title and project) and opens the task on that comment. A task you cannot see shows **Task not found**.
- **Linked documents**: mention a Knowledge document or a Drive spec in the description with `#`, or attach a file. The person who attached a file, or a projects administrator (`projects:settings:admin`), can remove it from the task: click its remove button, then confirm. A file posted with a comment goes with that comment.
- **Checklist**: track the steps or acceptance criteria of the task.
- **Copy task key** copies the task's short key.
- Under the key, **Created by** names who created the task and when. When an agent created it, the line names the agent (or the routine) instead of the person it acted for.

**Copy link** (on a task, and in a project's actions menu) copies the page's address. Paste it in a message or a task description and it becomes a chip that opens the project or task; it never notifies anyone.

To delete a task, click **Delete task**. Deleted tasks go to the project's **Trash**, where **Put back** restores them. A pending request to change a deleted task (an agent's request to delete it, for example) is cancelled, and the card tells the person who asked why; **Put back** makes it pending again.

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

## Add fields to a project's tasks

A project can declare up to 40 task fields: typed attributes every task of the project can carry, such as a "Problem type" choice, a serial number or an amount. A field has a key, a label and a type: text, number, amount (with its currency), date, choice, choices, checkbox, person or link. A field can be required.

To set them yourself, open the project and click **Fields** in its toolbar (on a phone, in the project menu). In **Task fields**, add a field with its label and type, tick **Required**, reorder fields with the arrows, edit a choice field's **Options** or remove a field, then click **Save fields**. Renaming an option renames it in every task that holds it. When the tasks' values stop a change, the dialog says which field and options are in the way.

Or ask an agent to set them (`fields_set`), or to create the project with them (`createProject` takes `fields`). Values are checked like the cells of a dashboard table: a value that does not fit its field, or a key the project does not declare, refuses the change and names the field. A required field must be filled when a person or an agent creates a task; imports, templates and moves never ask for it.

- Taking a field off the project keeps the tasks' values, hidden. Putting the same key back shows them again.
- A field's type cannot change while tasks hold values of it, and a choice option cannot be removed while tasks use it, unless you rename it to a kept option: the values are rewritten.
- A link value shows its label only to people who may open the linked app. Others see **Linked record**. The same holds for a template copied from a project (its maker's view) and for the task an event routine receives (its owner's view).
- Moving a task to another project keeps the values that fit the destination's fields and puts the others aside. They come back if the task returns.

On a task's page, the **Fields** section lists the project's fields under the status line. Click a value to edit it: it saves at once. **New task** asks for the required fields. A project without fields shows no **Fields** section.

## Status history

Every status change of a task is recorded: the status it left, the one it entered, who moved it (a person, their agent, a routine) and when. The history is append-only: nobody, an administrator included, can change or remove an entry; it goes only with its task. An imported task with an earlier creation date entered its status at that date. A task created straight into a status counts as entering it. On the task's page, the line under the status reads how long the task has been in its status (**In Review · 3d ago**); click **Status history** to list its changes, newest first. Agents read a task's history and how long it has been in its status with `get`, and every change emits the `projects:task:status_changed` event, which event routines can react to.

## Chart a project on a dashboard

`tasks_aggregate` counts a project's tasks (or up to 50 projects' at once) by status, handler (assignee), priority, due date, time in their status, SLA state or a choice, person, checkbox or date field, and can sum or average a number or amount field. Done tasks are left out unless you ask for them. It counts only the tasks you can read, so a dashboard shows each viewer their own figures. Any dashboard block can read it: a bar on `groupLabel` and `value`, a metric that sums `value`.

- **Time in status** groups tasks by how long they have been in their current status: less than 1 day, 1 to 3 days, 3 to 7, 7 to 14, 14 to 30, 30 days or more (or your own bounds).
- **SLA state** checks whether each task reached one of the statuses you name within a number of working days of its creation (the organisation's working hours, Monday to Friday 09:00 to 18:00 by default): met, missed, open and on time, open and late.
- Each group lists its tasks when there are at most 50, and the `tasks_byProject` filter that lists exactly them, so a chart opens the tasks behind a bar.

### A project overview dashboard

Ask an agent for "a project overview of Repairs" and it creates one dashboard in one call: a metric of open tasks, bars by status, by handler and by time in status, a metric of missed SLAs, and a table of overdue tasks that opens each task. Example spec, with your project and status ids:

```json
{
  "v": 1,
  "blocks": [
    { "id": "open", "type": "metric", "title": "Open tasks",
      "source": { "kind": "tool", "tool": "projects:tasks_aggregate", "params": { "projectId": "<project id>" } },
      "map": { "value": "value", "agg": "sum" } },
    { "id": "status", "type": "bar", "title": "By status",
      "source": { "kind": "tool", "tool": "projects:tasks_aggregate", "params": { "projectId": "<project id>" } },
      "map": { "x": "groupLabel", "y": "value" } },
    { "id": "handler", "type": "bar", "title": "By handler",
      "source": { "kind": "tool", "tool": "projects:tasks_aggregate", "params": { "projectId": "<project id>", "groupBy": "assignee" } },
      "map": { "x": "groupLabel", "y": "value" } },
    { "id": "aging", "type": "bar", "title": "Time in status",
      "source": { "kind": "tool", "tool": "projects:tasks_aggregate", "params": { "projectId": "<project id>", "groupBy": "age_in_status" } },
      "map": { "x": "groupLabel", "y": "value" } },
    { "id": "sla", "type": "metric", "title": "SLA missed",
      "source": { "kind": "tool", "tool": "projects:tasks_aggregate",
        "params": { "projectId": "<project id>", "groupBy": "sla", "sla": { "toStatusIds": ["<status id>"], "withinWorkingDays": 2 } } },
      "map": { "value": "value", "agg": "sum", "where": [{ "field": "group", "op": "in", "value": ["missed", "open_late"] }] } },
    { "id": "overdue", "type": "table", "title": "Overdue",
      "source": { "kind": "tool", "tool": "projects:tasks_byProject", "params": { "projectId": "<project id>", "due": "overdue" } },
      "map": { "columns": [{ "field": "title", "label": "Task" }, { "field": "assigneeName", "label": "Handler" }, { "field": "dueDate", "label": "Due" }],
        "link": { "entity": "task", "idField": "id", "app": "projects" } } }
  ]
}
```

### Edit tasks from a dashboard table

A [dashboard table](../agents/dashboard-tables.md) can show a project's tasks as its rows: its read-through columns are task values (title, status, assignee, due, priority, or any task field), and its own columns are notes kept per task. Editing a task value changes the task, with its history, as you; it needs the right to edit tasks. Adding a row creates a task; delete or archive a task in Projects.

## Automate a project with routines

A routine can react to a project's status changes and act on its tasks without an agent: assign the task, set a field or the status, comment, message a person or notify them, wait some working days and check again. The Projects app ships four routine templates for one project: `assign-on-status` (assign a task that reaches a status and tell the assignee), `remind-if-still` (remind the assignee when a task stays in a status two working days), `sla-to-reach` (tell the routine's owner when a new task is not done after three working days) and `notify-on-status` (tell the owner when a task reaches a status). See [Schedule routines](../agents/routines.md) for flows and filters.

## Project templates

A template holds the status columns, the task fields and a task tree a new project starts with, each task with its priority, status and field values. Ask an agent to save one (`template_save`), from scratch or by copying a project's statuses, fields and open tasks, then to create a project from it (`instantiate_template`). A stored template that can no longer be read refuses to create a project rather than create one without its tasks; `templates_list` marks it `unreadable`.

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
| `lead` | `member` plus `projects:projects:write` |
| `admin` | `lead` plus `projects:settings:admin` and `projects:labels:admin` |

`projects:approve` decides the approvals gated project tools raise. See the [scope reference](../reference/scopes.md) and [roles](../admin/roles.md).

## What agents can do

| Tool | What it does | Approval |
|---|---|---|
| `search`, `get` | Find and read projects and tasks. `search` with `involvedWithinDays` (1 to 90) returns only the tasks you were recently involved in, each with the reason. `search` leaves deleted tasks out unless you ask for them with `archived`, and marks them when they are included | No |
| `createProject` | Create a project with up to 20 tasks | No |
| `update_project` | Edit a project's name, description, group, icon, colour or key (the key only while the project has no task) | No |
| `instantiate_template` | Create a project from a stored template: its statuses, fields and tasks | No |
| `template_save`, `templates_list` | Save a project template (also from an existing project) and list them | No |
| `fields_set` | Set a project's task fields | No |
| `create` | Create a task in a project | No |
| `update` | Update a task | No |
| `move` | Move a task within or between projects | No |
| `delete` | Delete a task and its subtasks (to the trash) | Yes |
| `merge` | Merge one task into another | Yes |
| `add_dependency` | Make one task block another | No |
| `tasks_byAssignee`, `tasks_byProject`, `attentionItems`, `portfolio_rollup` | Task lists per person or project, your overdue and blocked work, a cross-project rollup | No |
| `comment`, `comments` | Write and read a task's discussion | No |
| `status_add`, `status_update` | Add or change a status column | No |
| `status_delete` | Delete an empty status column | Yes |
| `checklist_get`, `checklist_add_items`, `checklist_update_item`, `checklist_set_validation` | Read and edit checklists and record validations | No |
| `checklist_remove_item` | Remove a checklist item | Yes |
| `labels.list` | List the label groups and their values (`includeArchived` adds archived ones) | No |
| `labels.create`, `labels.update`, `labels.archive` | Create, rename, reorder, archive or restore a label group or value (needs `projects:labels:admin`) | No |
| `webhook_info` | Read the CI webhook setup | No |

To label a task, an agent passes `labels` to `create` or `update`: a map of group name to value name, such as `{"Nature": "bug"}`. `null` clears the task's own value, and groups left out are untouched. A name that does not exist, an archived value, or a value of another group refuses the whole call with `label_not_found` or `label_archived`, and the message lists the valid values. `bulkUpdate` with `operation: "setLabels"` does the same for many tasks. Every task an agent reads carries `labels`, with whether each value is inherited and from which task key.

An agent sets field values with `fields` on `create` and `update` (`null` empties a field), and `tasks_byProject` filters on them with `fields`: a value, a list of values, or `null` for an empty field. Each task row carries its `fields` and `statusEnteredAt`.

`tasks_byProject` takes a `labels` filter (one value per group, `__none__` for no value). With `terminal: true`, `completedAfter` (inclusive), `completedBefore` (exclusive) and `countOnly: true`, `totalCount` is the number of tasks of the project completed in that window with that label. Call it once per value and week for a weekly count.

In a task's discussion, the agent knows which task the conversation is about: its key, title and project. Ask it there to break the task into subtasks and it files them under that task.

See the [agent tool reference](../reference/agent-tools.md).
