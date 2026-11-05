---
title: Create an agent
description: "Create a role agent for a job, write its instructions, set what it may do, and give it skills and routines."
---

A role agent is a shared teammate with one job, such as answering support tickets or preparing shipments. You create it once, write its instructions, choose a model and set the most it may ever do. This page also covers editing your own personal agent.

To create or edit a role agent you need the scope `kernel:agents:admin`. Administrators have it. Everyone else can only edit their own personal agent.

## Create a role agent

1. Open **Agents**.
2. Click the **New agent** button (the plus next to the search box). The form opens as a tab, **New agent**.
3. Fill in **Name**. The **Handle** fills in from the name, for example `@support`. It is what people type to mention the agent. Change it now if you want, because it is fixed after you save.
4. Under **Description**, write one sentence on what the agent is for. The agent page shows it as the purpose.
5. Under **Instructions**, write what the agent should do and how. Plain sentences work best: its job, its tone, what it must never do, and when to hand off to a person.
6. Under **Model**, leave **Auto** or pick a model. See [Choose a model](../agents/models.md).
7. Under **Capabilities**, tick what the agent may do. This is its permission ceiling. See [Agent permissions](../agents/permissions.md).
8. Click **Save**. The agent's own page opens on its **Settings** tab.

A handle is `@` followed by letters, digits, dashes and underscores, up to 31 characters after the `@`, starting with a letter or digit. If another agent already uses it, Liaison refuses the save with `handle_taken`.

The ceiling cannot be wider than the permissions you hold yourself. If you try, the server refuses with `scope_ceiling_exceeded`.

Keep organization-administration scopes (`kernel:roles:admin`, `kernel:scope_requests:admin`, `kernel:policies:admin`, `kernel:users:admin`) out of a role agent's ceiling. Administration happens through a person's own agent, with that person's permissions. `liaison config apply` refuses a role agent that lists one, and approving an access request never adds one to a role agent.

### Include the basics in the ceiling

An agent only sees the tools its ceiling allows. Three basic scopes matter for almost every role agent:

| Scope | Why the agent needs it |
| --- | --- |
| `kernel:threads:read` | Lets it search for tools with `tool_search`. Without it, an agent has no app tools at all. |
| `kernel:threads:write` | Lets it ask other agents (`agents_ask`) and ask you to add one to a conversation (`agents_invite`). |
| `kernel:agent:memory` | Lets it keep notes across turns with the memory tools. |

Agents declared in a config file with `liaison config apply` get a common base automatically: skills, conversations, memory, contacts and files, knowledge documents, and projects. The base never includes administration. See [Config as code](../provisioning-cli.md). Agents you create in the form get exactly the capabilities you tick.

## Write good instructions

The **Instructions** field is the agent's own prompt. Liaison adds a workspace charter on top at run time. To see what the agent really runs on, click **Show instructions** under the field. The note above it reads: what the agent actually runs on is the instructions above, plus the charter this workspace adds.

- State the job and the limits in the first lines.
- Name the apps and the records it should use.
- Say what it should draft for approval and what it should never do alone.
- Keep step-by-step procedures in skills, not in the instructions.

## Add a picture

1. Open the agent's **Settings** tab after it is saved.
2. Click **Choose picture** and pick a PNG, JPEG, WEBP or GIF up to 5 MB.
3. Click **Remove** to go back to the default glyph.

## Pick a color

Each agent gets a color of its own when it is created: the one its workspace uses least, so the agents of a workspace look different until all eight colors are taken. The color shows on the agent's disc everywhere: the sidebar, the chats list, its messages and its page.

1. Open the agent's **Settings** tab after it is saved.
2. Under **Color**, pick one of the eight swatches. Use the arrow keys to move between them.
3. The color is saved at once.

## Give the agent skills

A skill is a written playbook the agent loads when a task matches. Skills keep the instructions short.

1. Open the agent's **Skills** tab.
2. Click **+ New skill**.
3. Enter a **Name** (letters, numbers and hyphens, for example `draft-reply`), a **Description**, and the **Body (markdown)**.
4. Optionally set **Domain (optional)** (for example `shipping`): lowercase letters, numbers and hyphens, 1 to 40 characters. It routes the skill's approval to reviewers with authority for that domain.
5. Click **Create skill**.

Skills are listed in two groups, **Agent skills** and **App skills**. Filter with **Built-in**, **Org** or **Personal**. When an agent itself creates or changes a skill with `create_skill`, `update_skill`, `delete_skill` or `toggle_app_skill`, the change waits for an approval. Skill approvals are decided by holders of `kernel:skills:approve`, narrowed by the skills domain. Reading skills needs `kernel:skills:read`, writing needs `kernel:skills:write`.

## Give the agent routines

A routine is a task the agent runs by itself, on a schedule or when something happens.

1. Open the agent's **Routines** tab.
2. Click **+ New routine** and follow [Schedule routines](../agents/routines.md).

## Give the agent knowledge and a place to work

- The **Knowledge** tab lists the collections the agent reads, with **Open in Knowledge**. See [Knowledge](../apps/knowledge.md).
- On the **Overview** tab, **Add to channel** puts the agent in a channel. Anyone in the channel can then mention it.
- Click **Message** to try it in a direct conversation before you share it.

## Edit your own personal agent

Every person has a personal agent that works with that person's own permissions. Open **Agents**, pick the one marked **Your agent**, then open **Settings**. The page says: this is your own agent, you can change its name, its picture, its color and its instructions. Its model and capabilities are not drawn for you, because a personal agent always works within your own permissions. An administrator (`kernel:agents:admin`) can edit everything.

A personal agent's ceiling follows its person: when they gain a role or a permission, their agent gains it too, and when they lose one, their agent loses it. An administrator can narrow one person's agent by setting its capabilities. That narrowing stays when the person's permissions change later, and the agent never gets more than the person holds. Setting capabilities that cover everything the person holds removes the narrowing.

## Archive an agent

You need `kernel:agents:admin`.

1. Open the agent's **Settings** tab, then open **Advanced**.
2. Click **Archive**.

An agent that still owns skills or routines cannot be archived. The page lists them and the message reads: this agent still owns skills or routines, reassign them first. Use **Reassign** on each one to hand it to another agent, then archive again. The system agent `@base` cannot be archived.

## Next steps

- [How agents work](../agents/how-agents-work.md)
- [Approve what agents do](../agents/approvals.md)
- [Tools agents can use](../agents/tools.md)
- [Roles](../admin/roles.md)
