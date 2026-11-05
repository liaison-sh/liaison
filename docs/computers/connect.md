---
title: Connect your computer
description: "Install the desktop app, connect it to your Liaison, sign in to Claude, and turn the computer on so agents can use it."
---

You turn a computer on once, from the desktop app on that computer. After that it appears in **Settings › Computers** from any device. This page takes you from a fresh install to a computer that agents can use.

## Before you start

- A Liaison account on your organization's server, and its address, for example `https://liaison.resonantaudiolabs.example`.
- A Claude account you can sign in to.
- The desktop app. See [Desktop and phone](../getting-started/desktop-and-phone.md). The app menu **Get the desktop app** offers macOS (Apple silicon and Intel), Windows, Linux (AppImage) and Linux (deb package).

## Connect the app to your Liaison

1. Open the Liaison desktop app. On first launch it asks **Enter your Liaison org URL:**.
2. Type the address and click **Connect**. If the address is not valid, the app says **That is not a valid Liaison URL.**
3. The app shows **Sign in to finish connecting** with **Your code** and **Open the approval page**. Click it. Your browser opens on your Liaison.
4. Approve the device. The app says **Waiting for you to approve this device** until you do. If you typed the wrong server, click **Use a different server**.

A link of the form `liaison://connect?server=https://...` also works. It opens the app and asks **Connect to this Liaison org?**. Nothing changes until you confirm. The web app can show this link for you.

If the app says that the Liaison server does not allow the desktop app, an administrator must allow the client `liaison-desktop` in the server's `DEVICE_FLOW_CLIENTS` setting. See the [environment reference](../reference/env.md).

## Sign in to Claude

Sessions run on your own Claude account, so the app needs you signed in.

1. Click **Sign in to Claude** when the app asks, or use the **Sign in…** button on the checklist below.
2. The app opens claude.com in your browser. Approve access. If Claude shows a code, paste it into **Code from Claude** and click **Submit**.
3. If the sign-in stalls, click **Open the page again**, or **Try again**.

## Turn the computer on

1. In the app, open **Settings › Computers**. While this computer is not set up, **Let your agents use this computer** comes first. It says that work you hand over in a chat, routines and requests from other agents can then run here, after three quick checks.
2. Work through the checks. Each shows **Done**, **To do**, **Checking…** or **Not available on this system**.

   | Check | What it means | Fix button |
   | --- | --- | --- |
   | **Signed in to Claude** | Sessions use your own Claude account. | **Sign in…** |
   | **Notifications** | You hear when a session needs you. | **Allow**. If your system refuses, open its notification settings and allow Liaison. |
   | **Open at login, and stay awake while plugged in** | Work does not stop when the computer restarts or idles. | **Turn on** |

3. Click **Turn on**.

The computer registers with your Liaison and receives its own credential, which the app keeps in a private file. From then on the page shows **Ready to work**. It is re-checked each time Liaison starts, and a problem also shows on the Computers page:

- **Signed in to Claude**
- **Notifications allowed**
- **Opens at login**
- **Stays awake while plugged in**, with **awake now, on power** or **on battery: it sleeps as usual**

Keeping awake is not available on Linux, where the check reads **Not available on this system**.

## Let Liaison read your folders

Your system may block Liaison from reading places such as Documents. The page then shows **Can read** with the places and a note that the system has not allowed it yet.

- **macOS:** System Settings › Privacy & Security › Files and Folders › Liaison. The button **Open System Settings** goes there.
- **Windows:** Windows Security › Ransomware protection › Allow an app through Controlled folder access.
- **Linux:** make sure your account can read them. For a Flatpak or Snap install, let Liaison access them too.

Click **Check again** after you change it.

## Manage a computer

Open **Settings › Computers**. Each computer shows whether it is **Online** or **Last seen**, how many sessions are running or waiting on you, how many folders and agents it has, and a switch **Let agents use** that computer. Click the row to open its page, with three tabs.

| Tab | What it holds |
| --- | --- |
| **Folders** | The folders agents can work in. See [Choose where agents can work](../computers/folders.md). |
| **Agents** | Which agents may run here, at what level, and who may ask them. See [Guardrails](../computers/guardrails.md) and [Run work on your computer](../computers/run-work.md). |
| **Settings** | Name and workload, and remove. |

On the **Settings** tab:

1. Change **Name** to the name agents and your phone use for it.
2. Set **Sessions at once** (1 to 16). More wait in line. The default is 4.
3. Set **Of which for others and routines**, the part of that number kept for requests from other agents and routines, so there is always room for what you start yourself. It cannot be higher than **Sessions at once**. The default is 2.
4. Click **Save**.
5. In the desktop app, **Auto for chats started elsewhere** lets chats you start from the web or your phone run in Auto or Edit instead of Manual. Turning it on is confirmed on this computer. See [Guardrails and permission modes](../computers/guardrails.md).

### Turn a computer off

Switch off **Let agents use** for the computer, or click **Turn off** under **Ready to work** in the app. Work that is already queued waits. Switching it back on resumes where it left off. If you removed the computer and turn it on again, it receives a new credential.

### Add another computer

Open Liaison on it and sign in. It shows up in **Settings › Computers** and asks you to set it up there. You can have several. When an agent needs a folder, Liaison picks the computer that shares it, preferring one that is online, then the one seen most recently.

### Remove a computer

1. Open the computer's page and the **Settings** tab.
2. Click **Remove** with the computer's name, then **Remove** again to confirm.

The computer stops being one of yours at once. Its credential stops working, and work queued for it moves to another computer or waits for you to add one.

## When something goes wrong

- **The computer shows as offline.** Open the app and check its connection. A computer is online while it holds a live connection, so a sleeping laptop is offline.
- **The assistant on this computer stopped.** The conversation shows **The assistant on this computer stopped** with the reason and **Retry**. If it keeps happening, update the app and send support the file `sidecar.log` from the app's log folder.
- **An update does not arrive.** The app writes each step to `updater.log`, next to `sidecar.log`.
- **Windows shell notice.** Local tools that run shell commands expect bash. On Windows, install Git Bash or enable WSL, then start the session again.
- **Messages that say to update.** If a screen says to update Liaison on this computer, or to update the server, one side is older than the feature.

The log folder:

| System | File |
| --- | --- |
| macOS | `~/Library/Logs/sh.liaison.desktop/sidecar.log` |
| Windows | `%LOCALAPPDATA%\sh.liaison.desktop\logs\sidecar.log` |
| Linux | `~/.local/share/sh.liaison.desktop/logs/sidecar.log` |

## Next steps

- [Choose where agents can work](../computers/folders.md)
- [Run work on your computer](../computers/run-work.md)
- [Security of a computer](../computers/security.md)
