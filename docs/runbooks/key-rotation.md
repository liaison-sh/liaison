# Rotating keys and secrets

How to replace each secret a self-hosted Liaison holds: what it protects, what
to change and in what order, and what people using the instance notice. Every
step below has been rehearsed against a local stack.

Commands assume the deployment layout of `deploy/docker-compose.yml`, run from
the directory holding it, with secrets in `deploy/.env`. Generate a 32-byte
key with `openssl rand -hex 32`.

| Secret | Protects | Rotation means | Downtime | What users see |
|---|---|---|---|---|
| `ENCRYPTION_KEY` | Stored secrets: connected account tokens and credentials, TOTP secrets, OAuth client secrets, MCP connection secrets, encrypted app settings and app config secrets, and the keys of server-managed mailboxes (only those keys are re-encrypted, never the mail itself) | Re-encrypt with `liaison keys rotate`, then restart on the new key | Minutes (app stopped while it runs) | Nothing, except an e-invoice send approved but not yet dispatched must be approved again, and a 2FA setup in progress must be started again |
| `BYOK_ENCRYPTION_KEY` | Each organization's own model provider keys | Same tool, `--family byok` | Minutes | Nothing |
| `JWT_SECRET` | Access tokens, file download links, MCP access tokens, a few server-side signatures | Change and restart | A restart | Each open session refreshes once, silently; a download link opened before the restart must be clicked again |
| Ticket intake API keys | The public ticket-create endpoint | Issue a new key, switch the caller, revoke the old one | None | Nothing |
| Model provider keys | Calls to the model provider | Replace the key | None | Nothing |
| OAuth client secrets | Sign-in with Google, Gmail and other OAuth connections | New secret at the provider, then in Liaison | None | Nothing |
| `LIAISON_REQUEST_PASSWORD` | The database login the API serves requests with | Change and recreate the app container | A restart | Nothing |

**Never change `ENCRYPTION_KEY` or `BYOK_ENCRYPTION_KEY` in `.env` alone.**
Every value encrypted under the old key stops opening: connected accounts fail,
two-factor sign-in fails, organizations lose their model keys. Nothing is
recoverable without the old key. `liaison keys rotate` re-encrypts first.

## Before you start

1. Take a backup (`docs/runbooks/production-bootstrap.md`, Backups) and check
   it restores.
2. Keep the OLD `ENCRYPTION_KEY` and `BYOK_ENCRYPTION_KEY` with every backup
   taken before the rotation. Those backups stay encrypted under the old keys,
   and a restore of one needs them (restore, start on the old keys, rotate
   again).
3. When rotating because a secret leaked, rotate everything that could have
   leaked with it, in this order: the database login (`LIAISON_REQUEST_PASSWORD`
   and `POSTGRES_PASSWORD`), `JWT_SECRET`, `ENCRYPTION_KEY` and
   `BYOK_ENCRYPTION_KEY` (one stop for both), then every secret held at a third
   party (OAuth client secrets, provider keys, API keys). The secrets stored
   encrypted in the database must also be rotated at their providers: a copy
   taken while they were readable stays valid until the provider revokes it.

## ENCRYPTION_KEY

The re-encryption keeps the algorithm, the format and the per-field context of
every value; only the key changes. It runs in one transaction (all or nothing)
and is safe to run again: a value the new key already opens is left alone.

1. Stop the app, so nothing writes a value under the old key during the run:
   ```sh
   docker compose stop app
   ```
2. Dry run. The keys are read from the environment variables you name, never
   from the command line:
   ```sh
   export OLD_ENCRYPTION_KEY=<current value of ENCRYPTION_KEY>
   export NEW_ENCRYPTION_KEY=$(openssl rand -hex 32)
   docker compose run --rm --no-deps -e OLD_ENCRYPTION_KEY -e NEW_ENCRYPTION_KEY app \
     liaison keys rotate --family encryption --from-env OLD_ENCRYPTION_KEY --to-env NEW_ENCRYPTION_KEY
   ```
   The report lists, per column, how many values it would re-encrypt
   (`rekeyed`), how many are already under the new key (`current`) and how
   many open with neither (`undecryptable`).
3. If `undecryptable` is not 0, stop: the old key is wrong, or those values
   were already unreadable before the rotation. `--execute` refuses while any
   value opens with neither key. When you know those values are lost anyway
   (for example a connection nobody uses), `--skip-undecryptable` rotates the
   rest and leaves them as they are.
4. Re-encrypt:
   ```sh
   docker compose run --rm --no-deps -e OLD_ENCRYPTION_KEY -e NEW_ENCRYPTION_KEY app \
     liaison keys rotate --family encryption --from-env OLD_ENCRYPTION_KEY --to-env NEW_ENCRYPTION_KEY --execute
   ```
5. Put `NEW_ENCRYPTION_KEY`'s value in `deploy/.env` as `ENCRYPTION_KEY`, start
   the app, and check a connected account and a two-factor sign-in:
   ```sh
   docker compose up -d app
   ```
6. Unset the two shell variables and store the old key with the pre-rotation
   backups only.

If the run is interrupted, run step 4 again: what was done is `current`, the
rest is re-encrypted. If you started the app on the new key before running it,
stop the app and run it: values the app wrote meanwhile are already under the
new key and are skipped.

What the key also covers, and what users notice:

- A 2FA setup started before the rotation and not yet confirmed (held for a few
  minutes in Redis) no longer confirms; the person starts it again.
- An approved e-invoicing send still waiting on the provider carries a grant
  signed with this key; it is refused after the rotation and must be approved
  again.

## BYOK_ENCRYPTION_KEY

Organizations' own model provider keys. Same procedure with `--family byok`:

```sh
docker compose stop app
export OLD_BYOK_KEY=<current value of BYOK_ENCRYPTION_KEY>
export NEW_BYOK_KEY=$(openssl rand -hex 32)
docker compose run --rm --no-deps -e OLD_BYOK_KEY -e NEW_BYOK_KEY app \
  liaison keys rotate --family byok --from-env OLD_BYOK_KEY --to-env NEW_BYOK_KEY --execute
# deploy/.env: BYOK_ENCRYPTION_KEY=<new value>
docker compose up -d app
```

Rotate both keys in one stop by running both commands before the restart.

## JWT_SECRET

Signs short-lived credentials only; nothing stored needs re-encrypting.
Sessions survive: refresh tokens are random values stored hashed in the
database, not signed with this secret.

1. Put a new value in `deploy/.env` (`JWT_SECRET=$(openssl rand -hex 32)`) and
   restart: `docker compose up -d app`.
2. What people notice:
   - Each signed-in browser, desktop or mobile app gets one 401 on its next
     call and refreshes its session silently. Nobody signs in again.
   - MCP clients refresh their access token with their refresh token, as they
     do every 15 minutes anyway.
   - A file download link handed out before the restart no longer opens;
     opening the file again issues a new one.
   - Ticket replies to emails sent before the restart no longer carry a
     recognised self-send marker, so a mail loop through an old message is not
     recognised as our own (new emails are).
   - A first-registration setup token derived from `JWT_SECRET` changes; set
     `LIAISON_SETUP_TOKEN` if a deployment that has not registered yet relies
     on the printed token.

## Ticket intake API keys

Keys for `POST /webhooks/<org>/tickets/create` (and the per-inbox form) are
stored hashed and rotated one at a time, with no downtime:

1. Issue a new key: in the Tickets app's API keys settings, or with `liaison
   config apply` and a new `apiKeys[]` entry. It is shown once.
2. Put the new key in the calling system and check a ticket arrives.
3. Revoke the old key in the same settings. It answers 401 from then on.

## Model provider keys

- An organization's own key (its AI provider settings): paste the new key; it is validated
  and stored encrypted, replacing the old one. Revoke the old key at the
  provider.
- The instance's platform keys (`LIAISON_ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_API_KEY`, `MISTRAL_API_KEY`, ...): change them
  in `deploy/.env`, `docker compose up -d app`, then revoke the old ones.

## OAuth client secrets

Most providers let a client hold two secrets during a rotation. Add the new
secret at the provider first, switch Liaison, then delete the old one there.
Connections already made keep working: their refresh tokens belong to the
client, not to the secret.

- Instance-wide Google sign-in and Gmail clients (`GOOGLE_OAUTH_CLIENT_SECRET`,
  `GMAIL_OAUTH_CLIENT_SECRET`): change in `deploy/.env` and
  `docker compose up -d app`.
- An organization's own Google client (the admin integrations settings, or
  `liaison connect` with the client in `--config`): save the new secret; it is
  stored encrypted and used from the next authorization on.
- Single sign-on providers (the admin OAuth providers settings): edit the
  provider and save the new client secret.
- Connector apps with their own OAuth client: reconnect from the app's settings
  with the new client.

## LIAISON_REQUEST_PASSWORD

The password of the `liaison_request` database login the API serves requests
with. The container's start step sets it (`ALTER ROLE ... PASSWORD` with a
SCRAM verifier computed in the container, so the password never reaches the
database's logs) before the server starts.

1. Put a new value in `deploy/.env` (`LIAISON_REQUEST_PASSWORD=...`, printable
   ASCII).
2. `docker compose up -d app`. The start step applies the new password, then the
   server connects with it. Connections opened with the old password are closed
   with the old container; new logins with the old password are refused.

`POSTGRES_PASSWORD` (the owner login, used for migrations) is changed in
Postgres itself (`ALTER ROLE liaison PASSWORD ...` as a superuser), then in
`deploy/.env`, then `docker compose up -d app`.
