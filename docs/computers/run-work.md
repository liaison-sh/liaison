---
title: Run work on your computer
description: "Hand a task to your own computer from a chat, run a conversation or a routine there, and let teammates' agents send work to it within limits."
---

Once a computer is turned on, there are five ways to put it to work: ask an agent in a chat, start a session yourself, run a whole conversation on it, run a routine on it, or attach an agent that others may ask. This page covers each one, and the limits that apply.

## Ask an agent to run something on your computer

1. In any conversation with your agent, say what you want and where, for example: "Fix the failing test in my-repo, on my Mac, with Opus."
2. The agent may ask you for what it is missing. **Where it works** and **which model runs it** are always your choice, never the agent's. It lists your shared folders and the models your computer offers.
3. When it has an answer, it starts a session with `run_on_my_computer`. A card appears in the conversation: **Run on** the computer's name, showing what runs, the folder (or **No folder**) and the model. Its progress and result show on the card. The card itself does not notify you; the result does, once, when the session posts it back to the conversation or the computer's turn answers (unless you are looking at that conversation).
4. Follow the session in **Sessions**. See [Sessions](../computers/sessions.md).

What you can state in your request:

| Option | Values | If you say nothing |
| --- | --- | --- |
| Folder | A folder you shared, or a repository (a git URL or the name of a shared repo) | The agent asks. Say "no folder" for work that needs none. |
| Model | A model your computer offers, by name | The agent asks. |
| Reasoning | `low`, `medium`, `high`, `xhigh`, `max` | The model's default. |
| Autonomy | Ask it to run on its own, without asking you | The session asks you when it needs you (guided). |
| When finished | `pr`, `commit` or `none` | The session opens a pull request. |

The session runs at the guardrail level of the agent's profile on that computer. There is no level to pick in the request. See [Guardrails and permission modes](../computers/guardrails.md).

An agent calls this only when you asked, or said yes to its suggestion. It never starts a session on its own initiative.

### When it asks for your approval

Code runs on your own machine, so the call waits for you in two cases. The turn read text from outside the organization, or it did not start from a message you typed (a routine, an inbound mail, a request from another agent, an MCP client). The card then reads **Waiting for your approval. Nothing runs until you approve.** with **Approve** and **Reject**.

Only the owner of the computer can decide it. An administrator cannot, and neither can a colleague with an approve scope. After you approve, the card reads **Approved. Starting on the computer…**. Other end states are **Rejected. Nothing ran.**, **Expired. Nothing ran.** and **Withdrawn. Nothing ran.**

### When it cannot start

The agent tells you why. The messages you may see:

| Message | What to do |
| --- | --- |
| None of your computers is set up yet | Open the desktop app, **Settings › Computers**, and turn the computer on. |
| No folder added on this computer matches that folder | Add it in **Settings › Computers › Folders**, or name a folder that is added. |
| This computer does not offer that model | Pick a model it offers, or leave the model empty. |
| That folder is no longer on this computer | Share it again or pick another folder. |
| This computer has not confirmed the agent's level yet | Confirm it in **Settings › Computers › Agents**. |
| Claude Code is not signed in on this computer | Sign in to Claude there. |
| The computer did not start the session in time | Check that the desktop app is open. |
| Update the Liaison desktop app on this computer | The app is older than this feature. |

When the folder is not shared, the card **Not started on** the computer says so and offers **Fix it**. Share the folder, then click **Start again**.

## Start a session yourself

1. Open **Sessions** and click **New**.
2. Fill in the dialog **New session on** the computer's name. See [Sessions](../computers/sessions.md#start-a-session-from-the-app).

## Run a conversation on your computer

A whole conversation with an agent can run on your computer, so every turn uses its files and tools.

1. In the conversation, open the runtime menu, **Where turns run**.
2. Choose your computer, which is listed by its name under **My computer**. In the desktop app you can instead choose **This machine**. The menu appears only when one of your computers is turned on and online.
3. Set the permission mode, **Permission mode on your computer**. See [Guardrails and permission modes](../computers/guardrails.md).

The setting is stored on the server per conversation and agent, so every device you use agrees on it. Only your own messages go to your computer. A message from anyone else in the conversation runs in the cloud.

While a turn runs on your computer, the conversation shows it as it shows a cloud turn. The agent reads **Queued** while the turn waits for your computer, then **Working**. The live turn starts with a **Run On My Computer** step naming the computer, then lists each tool the agent uses there with the command, file or address it acts on. Secrets are removed from these lines. Only you see the steps; the others in the conversation see that the agent is working. With an older desktop app the live turn shows only the **Run On My Computer** step.

Computers that are offline show as **(offline)** in the menu. The model list for a node chat is the models that computer offers, under **Models on** its name.

## Run a routine on your computer

Choose **My computer**, or **My computer, else the cloud**, under **Runs on** when you create the routine. Details, folders, models and the event level cap are in [Schedule routines](../agents/routines.md#run-a-routine-on-your-computer).

- With **My computer**, the run waits if the computer is offline, and you get a notification.
- With **My computer, else the cloud**, the run goes to the cloud when none of your computers is online. The fallback is recorded as a `fell_back` job.
- A run that was created while no computer was online asks you on the computer before it starts.
- A one-shot routine settles when its session ends.
- Where the workspace has credits, only cloud runs use them.

## Let other people's agents send work to your computer

You can attach an agent to your computer and say who may ask it. Matching requests then become sessions on your computer, and the answer is posted back.

1. Open **Settings › Computers**, click the computer, and open the **Agents** tab. The heading is **Agents that can run here**.
2. Click **Add an agent**, choose the agent under **Choose an agent**, and click **Add**.
3. On the agent's row, click **Edit**. **Who may ask it** reads **Only you** by default. Tick the other agents that may ask it and click **Save**.
4. Set the daily limits and click **Save** under them:
   - **Sessions a day others may start**, from 1 to 1000.
   - **Tokens a day for others' sessions**, from 1,000 to 1,000,000,000.

How it behaves:

- A request matches when the agent that asked, or the person behind it, is on the list. You are always allowed.
- A shared role agent has no owner, so an administrator has to allow the attachment first. A personal agent is yours to attach.
- If several attachments match, the earliest wins.
- The answer is posted in your own conversation with the agent. It is also posted in the conversation of the person who asked, when they may see it.
- When a daily limit is reached, the request is refused in words. It is never quietly sent to the cloud.
- Nobody else can send that agent work on your computer.

To remove an agent from your computers, click **Remove from your computers** on its row.

## Limits on a computer

On the computer's **Settings** tab, **Sessions at once** (default 4, from 1 to 16) is how many sessions run together. **Of which for others and routines** (default 2) keeps room for what you start yourself. More sessions wait in line.

## Let a session run on its own

By default a session asks you when it needs you. If you ask for **Run on its own**, it keeps going: after an empty turn it continues by itself up to 5 times in a row, and at most 30 times in a run, then asks you. It ends with `mark_done` when it is finished, or `needs_you` if it is truly blocked. A session that was started this way shows **Autonomous**.

## When a session finishes

A session started from a conversation posts one message back into that conversation when it ends by its own signal. The message names the computer and the title, quotes what the session said (clipped, and fenced as session data), and links the pull request when the computer verified one. Nothing is posted when you stopped it or marked it done yourself, or when it ended needing you, failed or stopped. Sessions started in the app post nothing.

## Next steps

- [Sessions](../computers/sessions.md)
- [Guardrails and permission modes](../computers/guardrails.md)
- [Choose where agents can work](../computers/folders.md)
