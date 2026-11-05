---
title: Upgrade Liaison
description: Check your version, choose the release or nightly channel, back up, move your Docker Compose stack to a new version, roll back a failed upgrade, and update installed apps.
---

An upgrade is: back up, point the stack at the new image tag, restart. Database migrations run when the container starts. This page covers the Docker Compose stack in `deploy/docker-compose.yml`.

## Check your version

Open **Settings › System**. It shows your **Channel**, the **Running** version and the **Latest** one on that channel. When a newer version exists, an **Update available** line links to its **Release notes**. When a release newer than yours fixes a security issue, the line reads **Security update available** instead: upgrade soon. Liaison checks GitHub for releases periodically; **Disable update checks** turns that off. Registering this server with the Liaison team does not change this check ([Share with the Liaison team](../self-hosting/liaison-team.md)).

What changed in each release is in the [release notes](../release-notes.md).

### Mark a release as a security fix

Maintainers: a release is a security fix when its tag annotation has a line that is exactly `Security: yes`. The release workflow then names the GitHub release `vX.Y.Z [security]`, and every instance older than it shows **Security update available**.

```sh
git tag -a v1.2.3 -m "v1.2.3" -m "Security: yes"
git push origin v1.2.3
```

The tag has to be annotated (`-a`): a lightweight tag has no message, so it is never marked.

## Choose a channel

An instance follows one of two channels. The desktop and phone apps have no channels: they follow releases only.

|  | `release` (the default) | `nightly` |
|---|---|---|
| What you get | Versions promoted from a nightly that has run on the maintainers' instances | A signed build of the newest `main` commit whose CI is green, once a day. It has had no soak |
| Image | `ghcr.io/mathieufro/liaison:latest`, or pinned: `:vX.Y.Z` | `ghcr.io/mathieufro/liaison:nightly`, or pinned: `:nightly-YYYYMMDD` |
| The version it reports | `vX.Y.Z` | `nightly-YYYYMMDD-<shortsha>`, also an image tag |
| **Settings › System** compares it with | The newest release | The newest nightly, or a release whose commit is newer |

Choose `release` unless you want fixes the day they land and can take a bad build now and then. A security release shows **Security update available** on both channels when it is newer than what you run.

### Set the channel

On a new install, pass it to the quickstart. It picks the image and writes `LIAISON_RELEASE_CHANNEL` and `LIAISON_IMAGE` to `deploy/.env`, and a later run keeps them:

```bash
./deploy/quickstart.sh --channel nightly
```

On a running stack, set both in `deploy/.env`, then follow [Upgrade the stack](#upgrade-the-stack). `LIAISON_RELEASE_CHANNEL` only decides what **Settings › System** compares against; `LIAISON_IMAGE` decides what runs, so keep them in step:

```bash
LIAISON_RELEASE_CHANNEL=nightly
LIAISON_IMAGE=ghcr.io/mathieufro/liaison:nightly-20270115
```

Without `LIAISON_RELEASE_CHANNEL`, an instance is on `release`. Any other value stops it at startup. Pin a dated tag on a server, so a restart never changes the version by surprise.

The channel's GitHub pre-release, `nightly-YYYYMMDD`, carries the matching `docker-compose.yml` and `.env.example`, and lists the commits since the previous nightly. The newest 14 pre-releases are kept. Images are not removed with them, so a pinned nightly can still be pulled after its pre-release is gone.

To check a signature:

```bash
cosign verify ghcr.io/mathieufro/liaison:nightly-20270115 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/mathieufro/liaison/.github/workflows/nightly.yml@refs/heads/main
```

### Migrations only go forward

You can move from `release` to `nightly` at any time: the nightly is newer and migrates the database when it starts.

Going from `nightly` back to `release` means staying on your version until a release includes it. Set `LIAISON_RELEASE_CHANNEL=release` and keep `LIAISON_IMAGE` on your nightly: **Settings › System** then shows **Update available** once a newer release exists. Move to that release as usual.

Rolling back onto an older image on a newer schema is not supported. An image older than the database's schema refuses to start. The container exits before it migrates, reinstalls apps or serves traffic, and its log says:

```text
FATAL: this image (Liaison v1.2.0) is older than the database schema: ...
```

To get out of it, do one of these:

- Point `LIAISON_IMAGE` at the version that migrated this database, or a later one.
- Restore a backup taken before the upgrade, then start the older image. See [Roll back a failed upgrade](#roll-back-a-failed-upgrade).

Only in an emergency, `LIAISON_ALLOW_OLDER_IMAGE=true` starts the older image anyway, with a warning in its log. That is not supported: nothing tests it, and the image reinstalls its older first-party apps. Remove it as soon as you have moved forward or restored.

Containers that are already running are not stopped by this. During a deploy the old ones keep serving on the new schema until they drain.

## Upgrade the stack

1. Back up:

   ```bash
   ./deploy/backup.sh
   ```

   See [Back up and restore](backups.md).
2. Set the new image tag in `deploy/.env`. The `app` service reads `LIAISON_IMAGE`:

   ```bash
   LIAISON_IMAGE=ghcr.io/mathieufro/liaison:v0.1.1
   ```

3. Pull the image and restart:

   ```bash
   docker compose -p liaison -f deploy/docker-compose.yml pull app
   docker compose -p liaison -f deploy/docker-compose.yml up -d
   ```

4. Wait until `/healthz` reports the new version with every dependency `ok`.

When the container starts, it runs the migrations, then reinstalls every enabled first-party catalog app from the image, then starts the server. A failed migration stops the container before it serves traffic. A catalog app that fails to reinstall is logged and does not block the start.

## What people see while the server restarts

While a server shuts down for an upgrade, the app shows a quiet line at the top of the page: **Liaison is updating. This usually takes less than a minute.** It goes away on its own as soon as the app is connected again. If the wait passes 90 seconds, the line becomes **Still updating. If this lasts, check your connection.**

When the connection drops without the server saying it is restarting, the line says **Connection lost, reconnecting…** (or **You're offline. Reconnecting when you're back.**) after 3 seconds. A shorter drop shows nothing.

## Run the migrations as their own step

Migrations take a lease in the database, so several containers that start at once apply each migration once: one runs them, the others wait, then find nothing left to do. A container that crashed while holding the lease loses it after 60 seconds. Stopping a container while it migrates (`docker stop`) releases the lease at once, and its unfinished migration is rolled back.

To migrate before you start new containers (for example when you run several API containers and replace them one by one):

1. Run the setup step once with the new image. It migrates, reinstalls the catalog apps, then exits:

   ```bash
   docker compose -p liaison -f deploy/docker-compose.yml run --rm app migrate
   ```

2. Start the new containers with `LIAISON_MIGRATE_ON_START=false`, so they skip the migration step. They still reinstall the catalog apps.

`LIAISON_MIGRATE_ON_START` defaults to `true`.

## Know what a new release may change in the database

While new containers start, the old ones keep serving against the new schema. So a release only adds to the schema: new tables, new columns that are nullable or have a default, new indexes. A column, table or value is removed only in a later release, once no running release uses it. That protects the old containers still serving during a deploy. It does not make the old image safe to start again: see [Migrations only go forward](#migrations-only-go-forward).

## Roll back a failed upgrade

1. Read `docker compose -p liaison -f deploy/docker-compose.yml logs app`.
2. If a migration failed, set `LIAISON_IMAGE` back to the previous tag.
3. Restore the backup you took before the upgrade:

   ```bash
   ./deploy/restore.sh <archive> --force
   ```

Do not only switch back to the old image without restoring: it refuses to start on the newer schema, `restore.sh` refuses a backup newer than the stack's image, and migrations only move forward.

## Update an installed app

Apps from the App store have their own versions.

1. Open **Settings › App store**. An app with a newer version shows **Update available**.
2. Open the app's listing and click **Check for updates**.
3. Review the preview, then click **Apply upgrade**.

You need `kernel:apps:admin`.

The new version runs without a restart. Liaison checks it first: its code must
load, it must register in every workspace where the app is running, and its
tools must register, within 30 seconds. Until it passes, every workspace keeps
the running version. If it fails, Liaison goes back to the version that ran before and
records why; the app keeps working on that version. Liaison keeps the previous
version of each app for this, and deletes older ones.

An upgrade that would lose data the running version keeps (a removed column, a
changed type, a narrowed list of values) is refused, with the list of what would
be lost.

## See how an app runs

**Settings › App store** shows one state for each app the workspace has on:

- **Running**: it loaded.
- **Failed to load**: it did not load in this workspace. The reason shows under
  its name and on its listing.
- **Upgrade failed**: a newer version failed its checks and Liaison went back.
  The listing says which version failed, which one still runs, and why.

The state is kept across restarts. From the server, `liaison app status` prints
the same states for every installed app (see the
[provisioning CLI](../provisioning-cli.md)).

## Roll an app back

Liaison keeps the version that ran before the current one. To go back to it:

1. Open **Settings › App store** and the app's listing.
2. Under **Version history**, click **Roll back to** the previous version.
3. Read the question and click **Roll back to** again.

The rollback applies to every workspace on the server, and the previous version
goes through the same checks as an upgrade: if it does not load, the current
version stays and the listing says why. A version released as a security fix
cannot be rolled back below; the button does not show.

Only the server operator can roll back. On a server that hosts several
organizations, that is the operator's organization; elsewhere, any admin with
`kernel:apps:admin`. From the server, run `liaison app rollback <name>`.

## Update the desktop app

The desktop app checks for new versions itself and asks before it installs one. See [Install the desktop and phone apps](../getting-started/desktop-and-phone.md).
