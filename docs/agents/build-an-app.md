---
title: Build an app with your agent
description: "Ask your agent for a small app of your own (a tracker, a log, a list): it writes it, checks it, tries it, and a person publishes it."
---

Your agent can build a small app for your organisation: a returns tracker, a visit log, a list of open requests. The app keeps its data in the organisation's data store, adds its own tools for the agent, and can show a page. Only your organisation sees it.

Building needs the `kernel:apps:build` scope; publishing is decided by a person holding `kernel:apps:admin`. Both are admin scopes by default.

## Turn it on (self-hosted)

The app builder, and installing an organisation's own app by URL, are off on a self-hosted server and on in the managed edition. To turn them on, set `LIAISON_CUSTOM_APPS=on` in the server's environment and restart it; `LIAISON_CUSTOM_APPS=off` turns them off on any server. While they are off, the agent has no app builder tools, **Apps in the making** is not shown, and the builder's requests answer 404. Apps already installed keep running; only new builds and installs stop. Apps the operator installs for the whole server are not affected.

## Ask for an app

Tell your agent what the app should do, for example "a returns tracker: log a return with its order number, reason and status, and list the open ones". The agent:

1. starts a draft from a working template: `store-crud` (one stored list, with a tool to list and a tool to add) or `read-only` (one read tool);
2. changes its files: the manifest, the handlers and, if you want a page, the interface;
3. checks it: the server builds it and type-checks it, and the agent fixes every error it reports;
4. tries each tool as you, without installing anything;
5. asks to publish it.

Each change is a new version of the draft. The last 20 versions are kept. A draft holds at most 512 KiB of files.

## What a try changes

A try (a preview) runs as you and changes nothing real:

- it can only read; any write to your organisation's data is refused;
- what the app stores goes to a scratch space of the draft: the next try of the same version still sees it, so you can add an item in one try and list it in the next. It is emptied when a try runs another version, when the agent asks for a fresh store, when the draft is discarded, and a day after its last write;
- one try of a draft runs at a time;
- before the first publish the app has no tables and reaches no website; after it, only the websites the published version was approved for;
- it never gets a password, a token or a connected account;
- a try lasts 30 seconds at most, and its log lines come back with the result.

## Publish it

Publishing waits for a person holding `kernel:apps:admin`. The approval card shows the app's name and version, the fingerprint (sha256) of the exact package, the result of its type check (ok, or how many errors and the first one), and what changes against the version running now: scopes, websites, tables and columns, connections, where a secret may be sent, calls to other apps, and the tables kept although the new version no longer declares them. No automatic approval applies.

What gets installed is exactly the package on the card: a change made to the draft after the request is not in it. The request cannot be edited; to change it, withdraw it and ask again. If the app moved to another version in between, the publish is refused and asked again.

An admin can also publish from the app builder directly, without an approval.

The first publish is version 0.1.0 and counts against the organisation's custom apps limit, when one is set. Each later publish is the next patch version (0.1.1, 0.1.2) of the same app. An app installed another way, or published by another draft, cannot be overwritten.

An app's page always runs in a sealed frame, never with your session.

## Open a draft in the app builder

Settings › App store lists your drafts under **Apps in the making** (you need the right to build apps). Open one to see its versions and whether each one builds, its files, and its interface in a sealed frame. The toolbar at the top has:

- **Check**: builds the version and lists any errors with their file and line.
- **Preview**: pick a tool, job or webhook, type its params as JSON, and **Run** it. The run is read-only; its result and log lines show below.
- **Publish**: an apps admin publishes after a confirm. Anyone else is told to ask the agent, which requests an admin's approval.
- **Discard**: drops the draft.

Each older version has **Restore**, which makes it the next version.

## After publishing

The app is On. Members get its member scopes automatically. Ask the agent to use it: it finds the app's tools with its tool search. The app's log lines are kept 7 days. An admin reads them in the app's settings page, under **Logs**, filtered by level or by one run.

To go back to an earlier version, ask the agent to restore it and publish again. Tables the restored version no longer declares are kept with their data.
