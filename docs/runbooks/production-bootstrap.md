# Liaison Production Bootstrap

This runbook is the canonical "from zero to a running Liaison instance" guide.
It assumes a Linux VM (Debian 12 / Ubuntu 22.04 / Alpine 3.20 — anything that
runs Docker) with public DNS pointed at it.

Sections — `bun run check:runbook-sections docs/runbooks/production-bootstrap.md`
asserts each heading is present in order.

## Prerequisites

- A Linux host with ≥ 2 vCPU, ≥ 4 GB RAM plus a 2 to 4 GB swap file, and
  ≥ 40 GB disk. Measured on a 2 vCPU / 4 GB host (Ubuntu 24.04, Docker 29):
  the whole stack idles at about 0.7 GB across its containers; building the
  image there from scratch takes about 7.5 minutes and peaks at 2.5 GB used,
  with almost no swap. A local build also leaves about 13 GB of build cache
  (`docker builder prune -af` reclaims it) next to the 3.7 GB image, which is
  what the disk figure covers. Add memory for a large team or heavy imports.
- Docker Engine ≥ 24 and Docker Compose v2 (`docker compose`).
- Outbound HTTPS for the GitHub Container Registry (`ghcr.io`) and the
  GitHub API (`api.github.com`).
- A public DNS record for the host (e.g. `liaison.example.com`): an A/AAAA
  record when a reverse proxy on the host terminates TLS, or a Cloudflare
  Tunnel route (see [TLS + DNS](#tls--dns)).
- `jq` and `curl` on PATH (used by the health checks below).
- Optional but recommended: `gh` (the GitHub CLI) for release inspection.

## Initial provisioning

**Pin the release tag you provision.** Always download release assets from a
specific `vX.Y.Z` tag, never `/releases/latest/download/...` — that URL moves
the moment a new release ships and silently shifts your compose/env baseline
out from under you.

1. Pick the exact version you want to deploy and put a checkout of that tag in
   `/opt/liaison`. The compose file is not standalone: it mounts the
   Postgres init hooks (`deploy/postgres-init/`) and the read-only role's
   grants (`apps/api/src/apps/database/generated/`) from the checkout, and
   `deploy/backup.sh`, `restore.sh` and `move.sh` run from it. With only
   `docker-compose.yml` and `.env` in a directory, Docker creates those mount
   sources as empty directories and the database comes up without the app's
   roles. Every `docker compose` command below runs in `/opt/liaison/deploy`.
   ```sh
   export VERSION=v0.1.0
   sudo git clone --depth 1 --branch "$VERSION" \
     https://github.com/liaison-sh/liaison.git /opt/liaison
   cd /opt/liaison/deploy
   ```
   Verify the tag is the release you expect:
   ```sh
   gh release view "$VERSION" --repo liaison-sh/liaison | head
   ```
   No release is published yet. Until the first one is, clone `main`
   (leave out `--branch`), build the image yourself from the checkout's root
   (`cd /opt/liaison && docker build -t liaison:local -f apps/api/Dockerfile .`,
   about 7.5 minutes on 2 vCPU), and set `LIAISON_IMAGE=liaison:local` in
   `.env` (step 2). The image then reports version `dev`, not a tag.
2. Generate secrets and object-storage credentials, then fill `.env`. Each
   `openssl rand -hex 32` produces 32 random bytes encoded as 64 hex chars —
   adequate for every required secret, including the object-store admin pair
   (SeaweedFS has no length requirement of its own; treat them like the other
   generated secrets here).
   ```sh
   umask 077 && cp .env.example .env   # .env holds every secret: mode 600
   {
     # Application secrets
     echo "JWT_SECRET=$(openssl rand -hex 32)"
     echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
     echo "BYOK_ENCRYPTION_KEY=$(openssl rand -hex 32)"
     # Postgres — distinct roles: privileged migrations, RLS-subject app, read-only allow-list
     echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
     echo "LIAISON_APP_PASSWORD=$(openssl rand -hex 32)"
     echo "LIAISON_REQUEST_PASSWORD=$(openssl rand -hex 32)"
     echo "LIAISON_READONLY_PASSWORD=$(openssl rand -hex 32)"
     # MeiliSearch
     echo "MEILISEARCH_MASTER_KEY=$(openssl rand -hex 32)"
     # Bearer token for GET /diag (monitoring); the app refuses to boot without it
     echo "MONITOR_TOKEN=$(openssl rand -hex 32)"
     # Object storage (SeaweedFS) — two distinct credential pairs:
     #  * OBJECT_STORE_ADMIN_* : administrative; loaded into the gateway's own
     #    identity config at container start, and used by the one-shot
     #    objectstore-init service to create the bucket.
     #  * OBJECT_STORAGE_* : the bucket-scoped app credentials the app uses
     #    (Read/Write/List/Tagging on that one bucket only — no admin).
     # Never reuse the admin credentials as the app credentials.
     echo "OBJECT_STORE_ADMIN_ACCESS_KEY=$(openssl rand -hex 12)"
     echo "OBJECT_STORE_ADMIN_SECRET_KEY=$(openssl rand -hex 32)"
     echo "OBJECT_STORAGE_ACCESS_KEY=$(openssl rand -hex 12)"
     echo "OBJECT_STORAGE_SECRET_KEY=$(openssl rand -hex 32)"
   } >> .env
   ```
   The appended lines override the empty placeholders above them (the last
   definition of a variable wins, for compose and for the deploy scripts).
   Open `.env` and fill in the non-secret values (`BASE_URL`,
   `ALLOWED_ORIGINS`, `SMTP_*`; `LIAISON_IMAGE` for a local build). For SMTP,
   port 587 upgrades with STARTTLS; port 465 also needs `SMTP_SECURE=true`.
   Never set `LIAISON_CONSOLE_EMAIL_BODIES` here: it writes sign-in codes to
   the log. `BASE_URL` must be your real public
   URL: production refuses to boot on the placeholder `http://localhost:3000`. Make sure every variable referenced
   by `deploy/.env.example` exists in your `.env`; compose will fail loudly
   with `:?` errors otherwise.
3. Pull and start the stack:
   ```sh
   docker compose pull
   docker compose up -d
   ```
   With a locally built image, skip `docker compose pull`: it cannot pull
   `liaison:local`, fails, and stops the other pulls with it. `docker compose
   up -d` pulls what is missing. The first start takes about a minute.
   On first start the one-shot `objectstore-init` service creates the
   object-storage bucket (the scoped `OBJECT_STORAGE_*` app identity already
   exists from the moment the `objectstore` gateway itself started — see
   `deploy/docker-compose.yml`), then exits. The `app` service waits for it to
   finish, so no manual bucket creation is needed. If file uploads later fail
   with access-denied, re-run `docker compose up -d objectstore-init` to
   re-provision (it is idempotent), or check `docker compose logs objectstore-init`.

### Database roles — privileged migrations vs. RLS-subject runtime

The stack uses two separate Postgres roles so row-level security is enforced
for all request traffic:

- **`liaison`** (the `POSTGRES_USER` bootstrap superuser, password
  `POSTGRES_PASSWORD`) is **privileged**: it owns the schema and tables and runs
  migrations via `MIGRATION_DATABASE_URL`. The migration step in the image
  entrypoint is the only thing that connects as this role.
- **`liaison_app`** (password `LIAISON_APP_PASSWORD`) is the **runtime** login
  role the app authenticates as via `DATABASE_URL`. It is `NOSUPERUSER`,
  `NOBYPASSRLS`, and owns no tables — superusers, `BYPASSRLS` roles, and table
  owners all skip RLS. It is a member of `liaison_admin` (BYPASSRLS) and
  `liaison_schema_admin`: the privileged work (`withPrivilegedDb`,
  `withSystemDb`, app registration DDL, the outbox worker) switches to them with
  `SET LOCAL ROLE`.
- **`liaison_request`** (password `LIAISON_REQUEST_PASSWORD`) is the login of
  every request transaction. It is a member of `liaison_rls` and nothing else,
  so SQL run from a request (a code path that forgets to set the role, or an
  injection foothold) cannot step into `liaison_admin`, cannot own a table and
  cannot change a policy. The app connects as it with `DATABASE_URL`'s host and
  database and that password (`DATABASE_REQUEST_PASSWORD` in the container);
  migration 0178 creates the role and the migration step gives it `LOGIN` and
  the password, sent as a SCRAM-SHA-256 verifier computed by the migration
  step (the password must be printable ASCII; the generated hex is). Without `LIAISON_REQUEST_PASSWORD`, requests run on
  `liaison_app` too. A connection pooler in front of Postgres (PgBouncer) must
  also know the `liaison_request` user.

`liaison_app` is provisioned on first cluster init by
`deploy/postgres-init/10-app-role.sh` (which reads `LIAISON_APP_PASSWORD`); the
baseline migration then grants it the schema/table privileges and the
`liaison_rls` / `liaison_admin` / `liaison_schema_admin` memberships. No
database credentials are baked into the image — every password comes from `.env`.
Keep Postgres off the host network (the compose `internal` network does this)
and treat every one of these passwords as highly sensitive.

4. Wait for the app to report healthy on the released version **with every
   dependency `ok`**. `/healthz` always returns HTTP 200 even when a dependency
   is down, so gate on the body — both the version and `all(.dependencies[] ==
   "ok")` — not just the HTTP status (for a local build, `export VERSION=dev`
   first, or the loop never ends):
   ```sh
   until curl -fsS http://localhost:3000/healthz \
     | jq -e '.status=="ok" and .version=="'"$VERSION"'" and (.dependencies | to_entries | all(.value=="ok"))' >/dev/null; do
     sleep 2
   done
   ```
   The container healthcheck applies the same dependency gate, so a container
   with a dead Postgres/Redis is marked `unhealthy` and drained rather than
   left in rotation.
5. Apply the read-only role's grants (the database connector's `liaison-self`
   reads). They name tables the app creates on its first start, so the
   cluster-init hook only creates the role and sets its password; once the app
   is healthy, run (idempotent; `deploy/quickstart.sh` does it for you):
   ```sh
   docker compose exec -T postgres sh /docker-entrypoint-initdb.d/20-readonly-role.sh
   ```
   **Installs made before this change:** the hook applied the grants during
   cluster init, before those tables existed, so the first init failed
   (postgres exited with code 3) and the restarted cluster kept a
   `liaison_readonly` role with no password and no grants. Everything else
   works; only the database connector cannot log in as that role. The same
   command repairs it: it sets the password from `LIAISON_READONLY_PASSWORD`
   and applies the grants.

## First-run bootstrap

The first user to register becomes the org admin (see Phase 13 setup flow).

> **Automated alternative.** Instead of the interactive wizard below, you can
> provision an org headlessly from a single config file with the `liaison config
> apply` CLI — recommended for Ansible/CI deploys, and it captures the org id +
> any org API keys in machine-readable form. See
> [Provisioning CLI](../provisioning-cli.md). The manual steps below remain
> valid for a hands-on first run. Claude Code or Codex can drive the whole
> setup, this runbook included, from
> [the setup playbook](../../.claude/skills/setup-liaison/SKILL.md).

0. **Find the one-time setup token.** A fresh production instance refuses the
   first registration unless it carries a setup token, so a stranger who finds
   the URL first cannot become the admin. The app prints it in its log at every
   boot until the instance has an org:
   `docker compose logs app | grep "Liaison setup token"` (or
   `journalctl -t liaison-app-1 | grep "Liaison setup token"`). By default it
   is derived from `JWT_SECRET` (the same on every node of an HA pair); to
   choose your own value for a scripted install, set `LIAISON_SETUP_TOKEN` in
   the env. Once the first account exists the token is no longer printed or
   checked.
1. Open `https://<your-host>/` in a browser and choose **Create an account**.
2. Enter your name and admin email, then the setup token when asked. Sign-in is passwordless: you'll receive an
   emailed sign-in code (magic link), no password required. The org is
   created as "Default Organization" and can be renamed later in Settings.
3. Once you land on the home tab, walk through the **Setup** wizard to enable
   apps (Threads, Knowledge, Mail, Tickets, Projects). Each app you enable
   adds an entity surface and a settings tab.
4. Optional: SMTP and object storage are configured via env only (`SMTP_*`,
   `OBJECT_STORAGE_*` in `.env`); there is no in-app settings page for either.
   Per-org BYOK AI keys are configured in-app under **Settings → Usage**.

If you skip the setup wizard, the kernel is functional but no apps are mounted
in the activity bar — you can return to setup at any time from
**Settings → Apps**.

### Direct browser uploads and downloads (S3, R2)

By default every file byte goes through the API: uploads PUT to
`/api/file-relay/<token>`, downloads stream from `/api/files/:id/inline`. That
is the only path when the object store sits on a private network (the bundled
SeaweedFS). When browsers can reach the store (Amazon S3, Cloudflare R2, a
SeaweedFS behind its own public https host), set
`OBJECT_STORAGE_BROWSER_DIRECT=true`:

- uploads PUT straight to a presigned URL (5 minutes; Content-Type and
  Content-Length signed); `/files/confirm` HEADs the object and deletes it
  unless size and type match what was authorized and it carries no
  Content-Encoding. Residual: until that URL expires, its holder (the
  uploader, nobody else) can PUT to it again, with the same declared type and
  length, even after the confirm. The store cannot tell a first write from a
  second; the short lifetime is the bound. The API relay refuses a token once
  the file is confirmed (409);
- downloads fetch a presigned GET (5 minutes, `Content-Disposition:
  attachment`, the stored type pinned, `Content-Encoding: identity`). Sealed
  (mailbox-encrypted) attachments, inline previews and the agent's file links
  still go through the API. File lists carry presigned thumbnail URLs in
  both modes, as before (none for a sealed file in direct mode);
- the CSP on API responses adds the store's origin to `connect-src` and
  `img-src`. The web page itself (`index.html`, served before the API's
  middleware) carries no CSP, so nothing on the page blocks the store: the
  bucket CORS rule below is the only browser-side requirement.

The bucket needs a CORS rule for every origin the app is served from: the web
origin(s) in `ALLOWED_ORIGINS` plus the desktop and mobile shells
(`LIAISON_APP_ORIGINS`, by default `capacitor://localhost`, `tauri://localhost`,
`http://tauri.localhost`). For Amazon S3:

```sh
cat > cors.json <<'JSON'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://liaison.example.com", "capacitor://localhost", "tauri://localhost", "http://tauri.localhost"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["content-type"],
      "ExposeHeaders": ["ETag", "Content-Length", "Content-Type", "Content-Disposition"],
      "MaxAgeSeconds": 3600
    }
  ]
}
JSON
aws s3api put-bucket-cors --bucket "$OBJECT_STORAGE_BUCKET" --cors-configuration file://cors.json
aws s3api get-bucket-cors --bucket "$OBJECT_STORAGE_BUCKET"
```

Imports upload large export files (up to the organization setting
`importFileSizeLimitMb`, 5120 MB by default) in parts straight to the bucket,
and the browser reads each part's `ETag` to finish the upload: the rule must
allow `PUT` and expose `ETag`, as above. At boot the server checks the bucket's
CORS configuration and logs a warning when either is missing. With
`OBJECT_STORAGE_BROWSER_DIRECT` off, import files go through the API relay and
are limited to `fileSizeLimitMb`; a larger one is refused with a message
naming that setting.

Apply the CORS rule first, then set the variable and restart the app. A
direct transfer that fails anyway (a missing origin, an expired URL) falls
back to the API relay, with a warning in the browser console. When the
presigned host is not the endpoint (a CDN or proxy in front of the store),
`OBJECT_STORAGE_PUBLIC_URL` replaces it, and the CSP follows.

## TLS + DNS

The compose stack publishes `APP_PORT` (default 3000) over plain HTTP, bound to
**loopback only** (`APP_BIND=127.0.0.1`) so it is never reachable off-host
without TLS. For production, terminate TLS at an HTTPS reverse proxy on the
same host. Caddy is the recommended default — it handles ACME issuance and
renewal with no extra config.

`/etc/caddy/Caddyfile`:
```caddy
liaison.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```
Then:
```sh
sudo caddy reload --config /etc/caddy/Caddyfile
```

Nginx + Certbot also works; mind WebSocket upgrade headers
(`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`).

**Cloudflare Tunnel instead of a proxy.** A host with no public port (a
home or office machine, or a VPS you would rather not expose) can run
`cloudflared` as a service with a tunnel route from your hostname to
`http://localhost:3000`. Cloudflare terminates TLS, so no Caddy or nginx is
needed and the DNS record is the tunnel's, not an A record. `cloudflared`
reaches the app from loopback, and Cloudflare appends the client address to
`X-Forwarded-For`, so the default `TRUSTED_PROXY_HOPS=1` is right.

**Proxy-hop awareness (`TRUSTED_PROXY_HOPS`).** Behind any reverse proxy you
**must** set `TRUSTED_PROXY_HOPS` to the number of trusted hops (1 for a single
Caddy/nginx; raise it per extra trusted layer such as a CDN). The `.env`
default is `1`. If it is left at `0`, the app reads the proxy's IP as the
client IP for every request, collapsing the per-client rate limiter and the
login brute-force throttle into one shared global bucket.

The app reads the client address as the **Nth entry from the right** of
`X-Forwarded-For` (N = `TRUSTED_PROXY_HOPS`): each trusted proxy appends the
address of the peer it saw, so everything to the left of those N entries is
client-supplied and is ignored. A proxy that *overwrites* the header (Caddy's
`reverse_proxy` does by default) leaves a single entry, which is that same
element. With no `X-Forwarded-For` at all the app uses the socket peer;
`X-Real-IP` is never read. For nginx, **overwrite** the header with the address
nginx itself saw; do not use `$proxy_add_x_forwarded_for`, which keeps whatever
the client sent in front:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

(Behind a CDN that is the only ingress, raise `TRUSTED_PROXY_HOPS` by one per
extra layer that *appends*, or have the proxy overwrite with the CDN's own
client-address header, such as Cloudflare's `CF-Connecting-IP`.) Never pass a
client-supplied `X-Forwarded-For` straight through.

The header is only read from a connection whose peer is a proxy the app trusts:
loopback and the private ranges (10/8, 172.16/12, 192.168/16, fc00::/7) always
are, so a proxy on the same host or private network needs nothing more. A
request that reaches the app port from any other address is keyed on that
address and its `X-Forwarded-For` is ignored. If your proxy or CDN connects to
the app from a public address, list its ranges in `TRUSTED_PROXY_CIDRS`
(comma-separated CIDRs).

**Firewall.** Because the app binds to `127.0.0.1`, only the proxy on the same
host can reach it; nothing further is required for the single-host topology.
If you set `APP_BIND=0.0.0.0` (proxy on a separate host), add a host firewall
rule allowing `APP_PORT` only from the proxy's address — and note that Docker's
published-port iptables rules **bypass** `ufw`, so use Docker-aware rules
(e.g. bind to the private interface IP, or an explicit `DOCKER-USER` chain
rule) rather than relying on `ufw deny`.

## Backups

One command backs up the whole instance into one archive, and the same archive
restores it here or on another host (see [Restore drill](#restore-drill) and
[Move a local trial to a server](#move-a-local-trial-to-a-server)):

```sh
./deploy/backup.sh            # add --keep 14 to keep only the 14 newest archives
```

It writes `deploy/backups/liaison-backup-<UTC timestamp>.tar.gz` (mode 600, in a
mode 700 directory; `--dir` picks another directory, and an existing one that
other users can read is refused, not silently changed), checks it reads back (gzip test, a checksum per part, the
object count), and prints its size and path. The archive holds:

| Part | What |
|---|---|
| `db.dump` | Postgres, custom format, one consistent snapshot (`pg_dump -Fc`) |
| `roles.sql` | The database roles and memberships, without passwords |
| `objects/` | Every object of the object-store bucket, with an index (key, size, content type, sha256) |
| `data.tar.gz` | The app's data directory (`deploy/data`: installed app packages, push key files) |
| `secrets.env` | The keys stored data cannot be read without (`JWT_SECRET`, `ENCRYPTION_KEY`, `BYOK_ENCRYPTION_KEY`, and `VAPID_*` when set), and, when set, the deployment's OAuth clients (`GOOGLE_OAUTH_CLIENT_*`, `GMAIL_OAUTH_CLIENT_*`, `GOOGLE_DRIVE_OAUTH_CLIENT_*`, `GOOGLE_MARKETING_OAUTH_CLIENT_*`, `SHOPIFY_APP_CLIENT_*`) and iOS push settings (`APNS_*`; the `.p8` file travels in `data.tar.gz`), so sign-in, Gmail, Drive and push keep working after a move |
| `manifest.json` | Liaison image and version, migration highwater, timestamp, counts, checksums |

The search index is not in it: a restore rebuilds it from the database.
Everything else in `deploy/.env` (URLs, ports, database and object-store
passwords, SMTP, platform model keys) belongs to the host and stays there.

**The archive holds the data keys.** Anyone with it can read every stored
secret. Keep it as private as `deploy/.env`, and encrypt it when it leaves the
host. Without its `secrets.env`, the connected accounts, model keys and
two-factor secrets in the database cannot be opened, so never keep the
database dump apart from the keys it was written under.

Everything runs inside the stack's own containers (the app image copies the
objects through the S3 API), so the host needs only Docker, `tar` and `gzip`.
The script needs no prompt, prints progress on stderr and the archive path on
stdout, and exits non-zero on any failure, so it fits cron. Two runs never
overlap (a lock in the backup directory). `--keep N` removes only archives with
the script's own timestamped names, never a hand-named one such as
`liaison-backup-before-upgrade.tar.gz`, and never the one just written. Nightly at 03:15,
keeping two weeks:

```cron
15 3 * * * cd /opt/liaison && ./deploy/backup.sh --keep 14 >>/var/log/liaison-backup.log 2>&1
```

Copy each archive off the host: a backup on the disk it protects is lost with
it. For example, encrypted with [age](https://age-encryption.org) and sent to
an S3-compatible bucket or another machine:

```sh
f=$(./deploy/backup.sh --keep 14)
age -r <your age public key> -o "$f.age" "$f"
rclone copy "$f.age" offsite:liaison-backups/   # or: scp "$f.age" backup-host:
rm "$f.age"
```

For object storage on a managed S3 service (AWS S3, Cloudflare R2, Backblaze
B2) rather than the bundled SeaweedFS, the provider's own versioning or
replication is a good second line next to the archive.

## Restore drill

**Run this before going live, then every few months.** A backup you have never
restored is not a backup. The drill is the same command as a real restore:

1. On a separate machine (or a throwaway checkout with its own compose
   project), prepare a fresh stack: a checkout of the same release or newer
   with its own `deploy/.env` (`./deploy/quickstart.sh` does it for a local
   test).
2. Copy the archive into its `deploy/backups/` and run:
   ```sh
   ./deploy/restore.sh deploy/backups/liaison-backup-<ts>.tar.gz
   ```
   Add `--base-url https://<the new host>` when the instance will be reached at
   another URL, and `--project <name>` when the stack does not use the default
   compose project name.
3. The script ends with its own verification: `/healthz` with every dependency
   ok, the organization and file counts of the backup, and one object read back
   against its checksum. Then sign in and open a few threads and files.

What `restore.sh` does, in order. Everything up to the database replacement
only reads, checks and starts services, so a failed check leaves the host as
it was; a failure after that point prints what was changed and how to put
`deploy/.env` back, and stops the app it started:

- checks the host tools, the archive's checksums, that the image is present
  (or pulls it), that the app image can read every archived object and reach
  the object store, and the target's state;
- refuses when the backup is NEWER than the stack's image (upgrade the stack
  first); an older backup is fine, the app applies the newer migrations when it
  starts, and the script says so;
- refuses when the stack already holds organizations, unless `--force`;
- writes the archive's keys and configuration into `deploy/.env`, keeps every
  host setting, sets `BASE_URL` and adds its origin to `ALLOWED_ORIGINS` when
  `--base-url` is given, pins `LIAISON_IMAGE` to the image it checked, and keeps
  the previous file as `deploy/.env.before-restore-<timestamp>`;
- creates the database roles this cluster lacks (with the source's attributes
  and memberships, never its passwords), then replaces the database from the
  dump, so every grant and RLS policy finds its role;
- puts the objects back in the bucket and the data directory in place;
- starts the app, rebuilds the search index (`liaison search reindex`), verifies,
  and prints what to change outside the host (DNS, OAuth redirect URIs,
  webhooks).

Document the date of every successful drill in your team's runbook log.

## Move a local trial to a server

A trial on a laptop or office machine moves to a server with its data, its
members and its connected accounts:

1. Prepare the server: Docker, a checkout of the same release or newer, and
   its own `deploy/.env` with the server's settings ([Initial
   provisioning](#initial-provisioning) and [TLS + DNS](#tls--dns)). Do not
   register on it.
2. From the trial machine's checkout, with SSH access to the server (key based,
   no password prompt):
   ```sh
   ./deploy/move.sh <user>@<server> --base-url https://liaison.example.com
   ```
   `--remote-dir` names the checkout on the server when it is not `~/liaison`.
   The script stops the trial's app (so nothing changes after the snapshot),
   backs up, copies the archive to the server's `deploy/backups/`, runs
   `restore.sh` there and prints the result. If any step fails, it starts the
   trial's app again: the trial stays the live instance until the server has
   restored and verified.
3. Do what the restore prints: point DNS at the server, add the new redirect
   URI to each OAuth client, and update the webhooks external services call
   (Gmail push, Shopify, Facebook, ticket intake callers).
4. Leave the trial's app stopped. Two running instances would both sync the
   same mailboxes and answer the same webhooks. Once the server has run for a
   few days, remove the trial with `docker compose -p liaison -f
   deploy/docker-compose.yml down -v` and delete its `deploy/.env` and
   `deploy/backups/`.

The same steps work by hand: `./deploy/backup.sh` on the old host, copy the
archive, `./deploy/restore.sh <archive> --base-url ...` on the new one.

## Upgrade

The stack is the compose file `deploy/docker-compose.yml` (published as the
release asset `docker-compose.yml`). An upgrade is: back up, point at the new
image tag, restart. Database migrations run on container start: the image
command (`apps/api/Dockerfile`, `CMD`) runs `src/db/migrate.ts` before it starts
the server, and a failed migration stops the container before it serves traffic.

1. Back up, as in [Backups](#backups):
   ```sh
   ./deploy/backup.sh
   ```
2. Set the new image tag in `.env` (the `app` service reads `LIAISON_IMAGE`):
   ```sh
   LIAISON_IMAGE=ghcr.io/liaison-sh/liaison:v0.1.1
   ```
3. Pull the image and restart the stack:
   ```sh
   docker compose pull app
   docker compose up -d
   ```
4. Wait for `/healthz` to report the new version with every dependency `ok`
   (the same loop as step 4 of [Initial provisioning](#initial-provisioning)).

To follow the nightly channel instead of releases, see
[Choose a channel](../admin/upgrades.md#choose-a-channel).

If the app does not come up, read `docker compose logs app`. When a migration
failed, set `LIAISON_IMAGE` back to the previous tag, then restore the backup
with `./deploy/restore.sh <archive> --force` (see [Restore drill](#restore-drill)).
An image older than the database's schema refuses to start, so going back to an
earlier image always goes through that restore
([Migrations only go forward](../admin/upgrades.md#migrations-only-go-forward)).

## Incident playbook

| Symptom | First check | Next step |
|---|---|---|
| `/healthz` returns 503 | `ls data/maintenance`: maintenance flag set? | Clear stale flag: `rm data/maintenance data/maintenance-version` |
| `/healthz` returns 200 but `dependencies.db=error` | `docker compose ps postgres` | Restart with `docker compose restart postgres`; check disk space |
| `/healthz` reports `dependencies.redis=error` | `docker compose ps redis` | Restart Redis; queues will catch up |
| WebSocket reconnect storm | `docker compose logs app \| grep ws:` | Confirm every replica reaches the same Redis: WebSocket state lives there |
| Migration left DB in unknown state | `docker compose logs app \| grep migration` | Set the previous image tag, then `./deploy/restore.sh <last archive> --force` (see Upgrade) |
| Storage failures uploading files | `docker compose logs objectstore` | Verify bucket exists; check SeaweedFS disk usage |
| A secret leaked, or is due for rotation | Which one (`docs/runbooks/key-rotation.md`) | Follow that runbook; never change `ENCRYPTION_KEY` or `BYOK_ENCRYPTION_KEY` in `.env` alone |

For anything not covered, gather:
1. `curl -fsS http://localhost:3000/healthz | jq .`,
2. `docker compose ps`,
3. last 200 lines of `docker compose logs app`,
4. the most recent backup filename.

## Where to file issues

- Bug reports and feature requests: <https://github.com/liaison-sh/liaison/issues>
- Security disclosures: report privately via [GitHub Security
  Advisories](https://github.com/liaison-sh/liaison/security/advisories/new)
  (see `SECURITY.md`); please do not open public issues for vulnerabilities.
- Commercial inquiries: see `CONTRIBUTING.md`
- General discussion: <https://github.com/liaison-sh/liaison/discussions>
