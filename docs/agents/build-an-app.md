---
title: Build an app with your agent
description: "Ask your agent for a small app of your own (a tracker, a log, a list): it writes it, checks it, tries it, and a person publishes it."
---

Your agent can build a small app for your organisation: a returns tracker, a visit log, a list of open requests. The app keeps its data in the organisation's data store, adds its own tools for the agent, and can show a page. Only your organisation sees it.

Building needs the `kernel:apps:build` scope; publishing is decided by a person holding `kernel:apps:admin`. Both are admin scopes by default.

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
- what the app stores goes to a scratch space of the draft, emptied at its next try and a day after its last write;
- before the first publish the app has no tables and reaches no website; after it, only the websites the published version was approved for;
- it never gets a password, a token or a connected account;
- a try lasts 30 seconds at most, and its log lines come back with the result.

## Publish it

Publishing waits for a person holding `kernel:apps:admin`. The approval card shows the app's name and version, the fingerprint (sha256) of the exact package, and what changes against the version running now: scopes, websites, tables and columns, connections, where a secret may be sent, calls to other apps, and the tables kept although the new version no longer declares them. No automatic approval applies.

What gets installed is exactly the package on the card: a change made to the draft after the request is not in it. The request cannot be edited; to change it, withdraw it and ask again. If the app moved to another version in between, the publish is refused and asked again.

An admin can also publish from the app builder directly, without an approval.

The first publish is version 0.1.0 and counts against the organisation's custom apps limit, when one is set. Each later publish is the next patch version (0.1.1, 0.1.2) of the same app. An app installed another way, or published by another draft, cannot be overwritten.

An app's page always runs in a sealed frame, never with your session.

## After publishing

The app is On. Members get its member scopes automatically. Ask the agent to use it: it finds the app's tools with its tool search. The app's log lines are kept 7 days.

To go back to an earlier version, ask the agent to restore it and publish again. Tables the restored version no longer declares are kept with their data.
