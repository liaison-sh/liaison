---
title: Install the desktop and phone apps
description: Install Liaison on macOS, Windows, Linux, iPhone or Android, connect it to your organization and sign in.
---

The desktop and phone apps wrap the same web app you use in the browser. The desktop app also lets agent sessions run on your own computer.

## Install the desktop app

1. In the web app, click **Get the desktop app** in the left bar.
2. Pick your installer:

   | Installer | For |
   |---|---|
   | **macOS (Apple silicon and Intel)** | a `.dmg` |
   | **Windows** | a setup `.exe` |
   | **Linux (AppImage)** | an AppImage |
   | **Linux (deb package)** | a Debian package |

The menu marks the one **Recommended for this computer**. The app checks for updates itself and asks before installing one.

On a Mac, open the `.dmg` and drag **Liaison** onto the **Applications** folder beside it, then open Liaison from Applications. A copy opened from the disk image or straight from Downloads cannot update itself: when an update comes out, it tells you to move it to Applications first.

On Linux, the AppImage updates itself when it sits in a folder you can write to, such as your home folder. The Debian package does not: when an update comes out, the app links to the new package, which you install the same way.

## Connect the desktop app to your organization

1. Open the app. At **Enter your Liaison org URL:**, type your Liaison address, for example `https://liaison.resonantaudiolabs.example`.
2. Click **Connect**. You can also open a connect link instead; the app shows the address and asks **Connect to this Liaison org?** before it uses it.
3. Sign in as you do in the browser: enter your email, then the 6-digit code.

To use another organization, use **Change server**. **Remove this server** signs you out of it and the app forgets it.

To reload the window (a page that stopped updating), use **View › Reload** on a Mac, or Ctrl+R or F5 on Windows and Linux; you stay signed in. When a message you have not sent, an attached file or unsaved settings would be lost, the app first asks **Reload and lose unsaved work?** and lists them: **Keep editing** cancels, **Discard and reload** goes ahead.

## Run agent sessions on this computer

The desktop app can run a conversation's agent on your machine, in a folder you choose.

1. When a session starts for the first time, the app shows **Approve this device**.
2. In your browser, enter the 8 character code shown in the app, review what it will be able to do, and click **Approve** (or **Deny**).

Approving starts a session on your computer that acts as you, with your access. Only approve a code you asked for. The local assistant needs you signed in to Claude on that computer.

When a chat runs on this computer from the web or your phone, the app sends each step the agent takes back to the chat as it happens, so the chat shows the turn live. An app older than this shows only that the turn is running. See [Run a conversation on your computer](../computers/run-work.md#run-a-conversation-on-your-computer).

The app's icon shows the badge, the unread things that ask for you (direct messages, mentions, approvals you decide), the same number as on your phone; direct messages and mentions play the system's sound. See [Notifications](../notifications.md#the-badge).

On Windows, local tools that run shell commands expect bash: install Git Bash or enable WSL.

See [Connect a computer](../computers/connect.md) and [Agent sessions](../computers/sessions.md).

## Use Liaison on your phone

The phone app is a shell around the same web app, for iPhone and Android.

1. Open the app. At **Enter your Liaison org URL:**, type your address and tap **Connect**.
2. Sign in with your email and the 6-digit code, a password, or a sign-in provider your organization set up.

The phone app does not create accounts. An admin invites you first (see [Invite and manage users](../admin/users.md)).

The phone app asks for the microphone only while you dictate a message, and for permission to send notifications.

A notification about a comment on a task is titled with the task. Tapping it opens the task with the comment brought into view.

When the connection drops, after sleep, a network change or the app coming back to the foreground, the app notices within about 10 seconds and reconnects on its own, in the browser, the desktop app and the phone app alike. The open pages then catch up on what happened while you were away.

Once you allow notifications, the phone stays registered for them across app updates: each time you open the app it checks its registration again, and retries on its own when the phone could not register. Opening the app clears the notifications of what you already read or decided, on any device (a reply once its reply thread is read), and keeps the others; the icon shows the same badge as your other devices. Signing out stops notifications to that phone until you sign in again. Signing out in the desktop or phone app forgets its stored sign-in on that device even when the server cannot be reached, so the next launch asks you to sign in.

## Apps your organization installed

In the desktop and phone apps, an app your organization installed runs in a sandboxed frame, apart from the rest of Liaison. A desktop or phone app that cannot open the frame does not load the installed app at all, rather than running the server's code in its own page.

Apps that come with Liaison come from your server too, at the version it runs:

- The desktop app checks that an app is exactly what Liaison released before it runs it in its own page. It downloads the app from your server, checks Liaison's signature with the keys built into the desktop app, and refuses a version Liaison withdrew. If any check fails, or your server runs a version Liaison did not sign, the app still works: it runs in the sandboxed frame.
- The phone app runs every app in the sandboxed frame, Liaison's own included. It only runs scripts it ships with.

## When some apps run in compatibility mode

Your organization's server may be updated before your app is. When an app's settings use something your desktop or phone app cannot show yet, that app keeps working in compatibility mode, and the app says **Some apps run in compatibility mode until you update Liaison.** An app in compatibility mode shows the icon its publisher gave it, or a tile with its initial when it has none. A setting the app cannot show yet says **This setting needs a newer version of Liaison. Update Liaison to change it.**

- On the desktop app, the app checks for an update right away and asks before installing it. **Check for updates** runs the check again.
- On the phone, update Liaison from your app store.

**Not now** hides the notice until another app, or another version of one, runs in compatibility mode. The browser never shows it: it always loads the server's own version.

## When the server needs a newer app

Your server sets the oldest desktop, iPhone and Android app it supports (`LIAISON_MIN_CLIENT_DESKTOP`, `LIAISON_MIN_CLIENT_IOS`, `LIAISON_MIN_CLIENT_ANDROID`, see [Environment variables](../reference/env.md)). The desktop or phone app asks once when it starts. An app older than that says **This server needs a newer version of Liaison.**

- On the desktop app, **Check for updates** runs the update check, which asks before installing.
- On an iPhone, it says **Update Liaison from the App Store.** On Android, **Update Liaison from Google Play.**

**Not now** hides the notice until you open the app again. The phone app's version is `1.0.` followed by its build number. The browser never asks and never shows it.

## If the desktop app cannot run a session

If the app says the server does not allow the desktop app to run conversations, the server's `DEVICE_FLOW_CLIENTS` is empty. The desktop client `liaison-desktop` is admitted whenever it is set; the shipped example sets it to `mcp-cli`. See [Run Liaison with Docker](../self-hosting/docker.md).

The local assistant's log is `sidecar.log`:

| OS | File |
|---|---|
| macOS | `~/Library/Logs/sh.liaison.desktop/sidecar.log` |
| Windows | `%LOCALAPPDATA%\sh.liaison.desktop\logs\sidecar.log` |
| Linux | `~/.local/share/sh.liaison.desktop/logs/sidecar.log` |
