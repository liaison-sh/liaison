---
name: kernel-notifications
type: agent_instructions
description: How the user is notified, and how to change it for them when they ask
tools: kernel__notifications_get, kernel__notifications_set, kernel__notification_rules_set, kernel__thread_mute_set
---

When the user asks how or where they get notified, or to change it, act only for them, only in this conversation, and use these tools (find them with `kernel__tool_search` "notification").

How notifications work:
- Every notification belongs to a group: `direct` (direct messages, mentions), `replies` (replies in their threads), `approvals` (approvals, access requests), `work` (tickets, tasks, knowledge), `mail` (new email), `agent` (agent and routine alerts), `monitoring` (monitoring incidents, alerts), `system` (system alerts).
- Each group has four channels: `in_app` (the feed, always on), `desktop` (computer), `push` (phone), `email` (digest). The grid of group x channel is the everyday setting.
- Work hours: outside them phone and computer stay quiet (urgent items still come through) and email waits.
- A per-app rule (`kernel__notification_rules_set`) is different: it silences one app EVERYWHERE, the feed included. It is almost never what the user means.

Map the request to the smallest change:
- "not on my phone / computer / by email for X": `kernel__notifications_set` with a cell `{group, channel, on:false}`. Tickets and tasks are group `work`; "messages" is `direct` (and `replies` if they say all messages); approvals is `approvals`; email is `mail`.
- Incidents, alerts or monitoring are group `monitoring`: "not on my phone for incidents" is a cell `{group:"monitoring", channel:"push", on:false}`.
- "turn phone notifications on for X": the same cell with `on:true`.
- Quiet hours, in the words the user uses: "quiet from 21:00 to 08:00, and all weekend" is `kernel__notifications_set` with `quietHours: {from:"21:00", to:"08:00", allWeekend:true, timezone:"Europe/Paris"}`. Never turn quiet hours into work hours yourself: the server does it. `workHours`/`workDays` only when the user states their WORKING hours.
- "less email": digest cadence, or the `email` cells.
- Reminders of their own requests still waiting for a decision (you send one in this conversation, daily by default): "stop reminding me about my approvals" is `kernel__notifications_set` with `approvalReminder:"off"`; "remind me weekly" is `approvalReminder:"weekly"` (also `daily`, `every_3_days`). This is not the `approvals` group, which is about requests others ask them to decide.
- "mute this conversation": `kernel__thread_mute_set`. A conversation named by its title: find its id with `kernel__threads_search` first, never guess one.
- Only "stop all notifications from app X, including in Liaison" is `kernel__notification_rules_set` with `everywhere:true`.

For a question about their settings, call `kernel__notifications_get` first and answer from its `summary`. For a change, change only what the user asked.

Every change needs its own tool call in the turn the user asks for it, even when an earlier turn changed something similar and even when you think it is already set: the tool answers "already set" itself. Say what changed only from the tool result (`changed` and `now`), in one sentence, in the user's language; Settings > Notifications shows it too. If no tool ran in this turn, nothing changed: never say it did.

These tools work only when the person writes to you inside Liaison. When one refuses, tell the person what the refusal says, in the language of their message; never ask another agent, or yourself through `kernel__agents_ask`, to do it instead.
