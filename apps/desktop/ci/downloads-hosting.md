# The public downloads host

`mathieufro/liaison` is a PRIVATE repository. Its release assets, and the
`releases/latest/download/latest.json` path the updater used to read, answer
404 to every anonymous client. An installed copy asking for its next version
gets nothing, a customer clicking a download link gets nothing, and there is no
credential either of them could be handed.

So the public surface is a Cloudflare R2 bucket in the Cloudflare account that
holds the liaison.sh zone,
served on the custom domain `downloads.liaison.sh`. The GitHub release stays as
the project's private record of what was built: the workflow keeps publishing
to it, and the mirror copies the same verified bytes to the public host.

## The layout

This is a contract. The web app links these paths, the shipped app reads the
manifest at one of them, and `apps/desktop/ci/downloads.ts` is the one module
that spells them.

| path | what |
| --- | --- |
| `desktop/<version>/<artifact>` | every release artifact under its canonical name from `ci/artifact-names.ts`: installers, updater archives, `.sig`, `.sha256`, `SHA256SUMS` |
| `desktop/latest.json` | the updater manifest, and the endpoint in `src-tauri/tauri.conf.json` |
| `desktop/latest/Liaison-macos.dmg` | a copy of the newest macOS installer |
| `desktop/latest/Liaison-windows-setup.exe` | a copy of the newest Windows installer |
| `desktop/latest/Liaison-linux.AppImage` | a copy of the newest AppImage |
| `desktop/latest/Liaison-linux.deb` | a copy of the newest Debian package |

Every `url` inside `latest.json` points at `desktop/<version>/<file>` on this
host and at nothing else. `apps/desktop/ci/mirror-to-downloads.ts` refuses to
publish a manifest that names any other host, and the rollback refuses to
restore one.

Versioned objects are served `Cache-Control: public, max-age=31536000,
immutable`. `latest.json` and the `latest/` aliases are replaced by every
release, so they are served `public, max-age=60`.

Windows installers are signed only once the Azure service principal is
configured. Until then a release publishes an unsigned installer, the two
signature gate says so loudly in the log, and that installer is now publicly
downloadable at `desktop/latest/Liaison-windows-setup.exe`, where SmartScreen
will warn about it. That is the accepted posture for the first releases, not an
accident.

## The transport

Objects go through R2's S3 compatible endpoint,
`https://<account>.r2.cloudflarestorage.com`, and never through the Cloudflare
REST object API: that one caps a request body at 100 MB and has no multipart,
while the disk image is 123 MB and the macOS updater archive 111 MB.

The request is a PUT presigned by Bun's built in S3 client, with the body
streamed from a `Bun.file`, so no installer is ever read into this process's
memory. It is presigned rather than written through `S3Client.write` because
that method sends Content-Type and nothing else: it has no cache control
option, so every object would take the edge's default lifetime and a
`latest.json` cached for hours is a release nobody is offered. A presigned url
signs the host alone, which leaves the PUT free to carry both headers.

Each upload and each read back retries three times on a 5xx or a dropped
connection, backing off. An upload never retries a 4xx: that is the server
saying the request itself is wrong. A source file that cannot be read is not
retried at all.

## Order, which is the safety property

`latest.json` is acted on by every installed machine with no human in the loop.
Written before the files it names exist, it sends every machine that polls in
that window to a 404. So the mirror does, in this order:

1. uploads every versioned artifact,
2. reads each one back with a public request to `downloads.liaison.sh` (not to
   the API: a bucket with no custom domain attached accepts every upload and
   serves nothing),
3. uploads the `latest/` aliases and reads those back,
4. uploads `latest.json`, last, and only if everything above succeeded.

Every read back carries a unique query string, fresh on each attempt, and a
rolling key (an alias, the manifest) sends `Cache-Control: no-cache` as well.
Two caches would otherwise answer with the wrong thing: the object a rolling
key replaced may still be at the edge, and a versioned key read a moment
before R2 is consistent has its 404 cached, so a retry on the same url would
read the miss it is retrying. For that reason a read back retries a 404 too,
which an upload never does.

Before any of that it re-runs the two signature gate over the same publish
request the release job acted on, in dry run mode, through
`ci/verify-and-publish.ts` itself, and it compares the `latest.json` on disk
with the manifest that run produced, field for field. It is not a second
implementation: this script must never become a way to put bytes in front of
customers that the gate never saw.

## The one time setup

1. In the Cloudflare account that holds the liaison.sh zone, create an R2
   bucket named `liaison-downloads`. The custom domain in step 2 only attaches
   when the zone and the bucket live in the same account.
2. Attach the custom domain `downloads.liaison.sh` to that bucket (R2 bucket
   settings, Public access, Connect domain). Without this every upload succeeds
   and every public read fails, which is exactly the state the mirror's read
   back step refuses to publish over.
3. Create an **R2 API token** with **Object Read and Write** on the bucket
   `liaison-downloads` (an account-wide R2 token with the same right also
   works). Creating it shows an Access Key ID
   and a Secret Access Key once: those two are what the mirror signs with, and
   they are the reason this is an R2 token rather than a plain Cloudflare API
   token.
4. Add three repository secrets to `mathieufro/liaison`:
   `LIAISON_DOWNLOADS_CF_ACCOUNT_ID` (the Cloudflare account id),
   `LIAISON_DOWNLOADS_R2_ACCESS_KEY_ID` and
   `LIAISON_DOWNLOADS_R2_SECRET_ACCESS_KEY`. The bucket name is not
   configurable: one public host, one bucket.

The release workflow reads those three secrets in one step,
`Mirror the release to the public downloads host`, which runs after the GitHub
release is published and never on a dry run.

## Running the mirror by hand

From a downloaded release, on a Mac (the gate needs `codesign`, `spctl` and
`stapler`):

```
gh release download desktop-v<version> --dir release-artifacts
bun apps/desktop/ci/build-publish-request.ts \
  --artifacts release-artifacts \
  --tag desktop-v<version> \
  --notes-file apps/desktop/ci/RELEASE_NOTES.md \
  --out publish-request.json

# Rehearse: this reads no secret, uploads nothing, and prints the plan.
bun apps/desktop/ci/mirror-to-downloads.ts \
  --request publish-request.json \
  --manifest latest.json \
  --artifacts release-artifacts --dry-run

export LIAISON_DOWNLOADS_CF_ACCOUNT_ID=...       # from the password manager
export LIAISON_DOWNLOADS_R2_ACCESS_KEY_ID=...
export LIAISON_DOWNLOADS_R2_SECRET_ACCESS_KEY=...
bun apps/desktop/ci/mirror-to-downloads.ts \
  --request publish-request.json \
  --manifest latest.json \
  --artifacts release-artifacts
```

`latest.json` is the manifest the release published; download it from the same
release beside the artifacts. The script prints no credential, and every error
it throws has the account id, the access key id and the secret replaced.

## Rolling back

`ci/rollback-manifest.ts` republishes a previous release's manifest, unchanged,
to both surfaces: the GitHub release asset first (the record) and
`desktop/latest.json` on the downloads host second (the copy every installed
machine actually reads). It needs the same three environment variables, and it
refuses a prior manifest whose urls are not on the downloads host, because
restoring one of those would replace a broken build with an update channel that
404s on every platform.
