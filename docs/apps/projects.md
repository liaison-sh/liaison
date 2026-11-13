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

## Turn on time and budgets for a project

Time and budgets is off on every project until you turn it on, one project at a time. Ask the agent ("turn on time and budgets for Atlas"), or pass `timeBudgets` when you create or edit a project through the API (`POST /api/projects`, `PATCH /api/projects/:projectId`). You need `projects:projects:write`, which the `lead` and `admin` roles hold. A sales pipeline cannot use it.

- **What it adds.** A project that uses it can hold planned time (a timebox on a task, a period or the whole project), the time people say they spent (Took), a billing basis and its rate or fixed price, and dated hours.
- **The time tools follow the projects.** While no project uses it, the time tools are not in any agent's tool list or a coding agent's MCP list. The first project turned on adds them from the next message; the last one turned off removes them again. Nobody turns this on for the whole organisation.
- **Turning it off keeps everything.** Its rows stay, and nothing counts them until it is turned on again.
- **Only a person turns it.** A routine, a sub-run or a job is refused.
- **Tell your team first.** When the first project of the organisation is turned on, the person who turned it and every admin read a notice, once: tell the team what is recorded and why before anyone records time. With 50 or more people, consult your staff representatives first. Tell them too what an admin's organisation export holds: only the entries on a project's dated sheet, never a person's own private time or cost rate.
- **An archived project no longer counts.** While the only projects that use it are archived, the time tools leave the tool lists; restoring one brings them back.

## Record time on a task

On a project that uses time and budgets, a task takes a timebox ("3 days", "20 h") and a Took entry, the time you say you spent ("2 h", "1h30", "half a day", "2 days", or in French "2 j", "demi-journée"). A day is the organisation's hours in a day, 7 h unless changed.

- You record only your own time, and only from your own words. An agent records it only with what you said, and never proposes or rounds a figure. From your coding agent (MCP), your own connection records it, marked as said through the coding agent.
- Without dated hours you have one entry per task: editing replaces it, clearing removes it. With dated hours, each entry has a day, today by default, never a future day.
- Nothing reminds anyone to enter time, and colleagues see only the task's total, never your part.
- **On the task and in lists.** A task of a project that uses it shows its Timebox chip and your Took field in its details, and "N h so far", the task's total. Through the API, the task (`GET /api/projects/:projectId/tasks/:taskId`) and the task lists carry `timeboxMinutes`, `realTotalMinutes` (the total, never a person's part) and `isMilestone`; a task of any other project carries none of them. The cross-project task list shows "Planned" only on those tasks.
- **Dated hours** are turned on in the project's plan. From that moment the project's lead and finance see each person's entries made on it and can correct one, to another day that is not in the future and has no entry of that person yet; the author then sees who changed it. Entries made before, including earlier the same day, stay private to their authors, and so do they after dated hours are turned off and on again. Everyone with entries is told once on Home.
- A task moved to another project takes its time with it at once, whatever moved it (the board, the API or an agent). A task moved to a project that does not use time and budgets keeps its timebox and time spent, which stop counting until it is back. A merge adds the source's time to the target, one entry per person (per day with dated hours); a merge that would put more than 744 h in one entry is refused. Entries made on a project without dated hours stay private to their authors after a move or a merge into one that uses them.

## Read a project's budget

On a project that uses time and budgets, ask the agent for its budget ("how are we doing on the portal project"). It answers in one line, planned time against real time, and a card with the milestones and the totals.

- **One line.** Real time against the planned time, in hours (days on a project billed by the day). A retainer or a day-rate project reads the month or period it is in ("November so far 18 of 40 h"). A fixed-price project over its timebox says how far over, and that the price does not change. A project with no timebox says there is nothing to compare.
- **Which planned time counts.** A timebox set on the whole project wins the line. Without one, the line is the sum of the top tasks' timeboxes; a task's own timebox counts and the timeboxes under it do not add to it. Milestones always show their own.
- **Coverage.** Real time is entered by people afterwards, and not on every task. The line says on how many tasks it was entered, out of the tasks that have started or are done, and any figure built on real time reads "partial" until every one has some. Coverage is about the project, never about a person.
- **Money.** The price shows only to people with `projects:money:read`; others read the hours alone.
- **On the project page.** The budget line sits under the project's name and the budget panel beside the board. Its ask box puts your question in your conversation with your agent, ready for you to send; it sends nothing by itself.
- **The plan in the edit form.** Edit project shows the plan as it is (how it is billed, the rate, who bills it, dated hours), read with `GET /api/projects/:projectId/time-plan`. The rate or fixed price comes back only with `projects:money:read`.
- **Before the project used it.** If tasks closed before the project started using time and budgets, the answer says so with the date. No figure changes because of it.
- **Archived tasks.** Their time is not counted, and the answer says how much is left out.

## Read capacity and set days off

Once a project uses time and budgets, ask the agent who is free ("who has room next week") or open **Capacity** in Projects. It lists, for one week, each person's planned time against their available time, in name order, with a note when someone has more than fits (over by more than 3 h) or has room (5 h free or more).

- **Planned time comes from timeboxes only**, on projects that use time and budgets. A task with a start and a due date spreads over its working days; with a due date only it falls in that week; with no date, in the current week. Time people entered never changes capacity.
- **Available time** is hours in a day times the person's working days that week: weekdays that are not company days off or their away days, at most their days per week. A colleague's day off shows only as a smaller available figure, with no date or reason.
- **Who is listed.** People with planned work in that week or later. Open work assigned to someone who has left shows in one row, "Assigned to people who have left". There is no sort and no ranking.
- **Who can take a task.** Asked about one task, the answer lists people with enough room, those already working on that project first.
- **Company days off** (a day, a range or an ISO week, optionally every year) are set in **Settings > Projects > Time and budgets**, or by asking the agent, with `projects:settings:admin`. The answer states the exact dates. One person's own days are away days, set from their profile or with the agent.
- **Days per week.** A person working part time sets their days per week (1 to 5) by asking the agent; a lead with `projects:capacity:write` or an admin with `kernel:users:admin` can set it for them, and the person gets a line on Home saying who did. No weekday or reason is stored.
- **Hours in a day** (7 by default) are set in the same settings section.
- **Read a shared calendar** (none by default) turns the whole-day events of the chosen calendar into company days off, once a day, for the next twelve months. Part-day events, out of office, focus time and birthdays make no day off, a day you typed on the same date wins, and an event removed from the calendar removes its day. Nothing else is read: no one's own calendar and no country's holidays. If the calendar can no longer be read (disconnected, unticked, or its owner left), its days stay as typed days, the setting clears, and settings admins get one line on Home asking for a new calendar. The section's settings keys are `hoursPerDay` and `daysOffCalendarId`, and a day off's **Every year** switch is `yearly`; the `time_settings_set` and `days_off_set` tools take the same names.

## Lines on Home

The time and budgets lines sit together on Home under **Time and budgets**, quietly: no count and no urgent colour. Nothing ever reminds anyone to enter time, and a missing entry never raises anything.

- **More planned than fits.** When someone has more than 3 h more planned than fits in the current week, the leads of the projects holding that work (the project's owner and the people working on it who hold `projects:capacity:read`) get one line, never the person. It comes once per person and week; **Not now** hides it for the rest of the week, and the week's end retires it.
- **Month close.** On the last working day before a month's last day, the person who bills a project (its biller, else its owner) gets one line for each daily, hourly or retainer project with nothing reconciled for that month yet. It shows that day only and does not come back if missed.

## Reconcile a project's month

On a project that uses time and budgets, ask your agent in your DM with it, or your own coding agent, to reconcile a period ("reconcile Atlas October"). The agent reads the period's closed tasks, then the traces you can read yourself (commits, meetings, notes, mail), and proposes a card of lines: what was planned, what was spent and what to bill.

- **Only on your own turn, in a DM.** A routine, a sub-run, a job or a shared conversation is refused. The agent reads only what you can read, so the card says what it did not see, and that someone else may see more.
- **The server works out every figure.** A line groups tasks and says why; its planned time comes from the tasks' timeboxes, its real time from what people entered, and its bill by a fixed rule: a planned line bills what was planned, never more; a line not in the plan bills nothing; a retainer bills what was spent. Nothing a commit or a note says changes a figure.
- **No one is named.** A line that names a member of the team is refused; a client's own contact may be named. Tasks the client's own people did can be left out, and every other task of the period appears, in "Other closed tasks" if no line lists it.
- **An estimate is not time.** Where no time was entered, the agent may show an estimate tied to a proof, marked `~`. It never counts as time spent, in the budget, the coverage or the bill.
- **What you cannot open stays off.** A meeting from a colleague's personal calendar, or a document not shared with you, cited as proof is dropped from the card, and the card lists Calendar or Knowledge as not seen.
- **Work for another client.** A line of one task done for another client, with that client's project named, offers "Move it to" that project's key on the card; the click moves the task there. A project you cannot open is refused when the card is saved.
- **Only you see it.** The card stays yours while it is a proposal. Asking again with nothing changed returns the same card; a change updates it. Asked after the period ended, the card says the invoice issues with today's date.

## Roles and scopes

| Role | Scopes |
|---|---|
| `member` | `projects:projects:read`, `projects:tasks:read`, `projects:tasks:write` |
| `sales` | `member` plus `projects:deals:read` and `projects:deals:write` (deal amounts) |
| `lead` | `member` plus `projects:projects:write`, the deal scopes, `projects:money:*`, `projects:reconcile:*` and `projects:capacity:*` |
| `finance` | `member` plus `projects:money:*`, `projects:reconcile:*`, `projects:margin:read`, `projects:cost_rates:write`, `projects:timesheet:read` and `projects:capacity:read` |
| `admin` | `lead` plus `projects:settings:admin` and `projects:labels:admin` |

`projects:money:read` and `projects:money:write` read and set a project's billing terms (rate or fixed price). `projects:reconcile:read` reads a reconciliation once it has left its creator's proposal, and `projects:reconcile:write` reconciles a project's period. `projects:approve` decides the approvals gated project tools raise. See the [scope reference](../reference/scopes.md) and [roles](../admin/roles.md).

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

An agent sets field values with `fields` on `create` and `update` (`null` empties a field), and `tasks_byProject` filters on them with `fields`: a value, a list of values, or `null` for an empty field. Each task row carries its `fields` and `statusEnteredAt`.

`tasks_byProject` takes a `labels` filter (one value per group, `__none__` for no value). With `terminal: true`, `completedAfter` (inclusive), `completedBefore` (exclusive) and `countOnly: true`, `totalCount` is the number of tasks of the project completed in that window with that label. Call it once per value and week for a weekly count.

In a task's discussion, the agent knows which task the conversation is about: its key, title and project. Ask it there to break the task into subtasks and it files them under that task.

See the [agent tool reference](../reference/agent-tools.md).
