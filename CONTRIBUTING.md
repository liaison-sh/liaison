# Contributing

Liaison is source-available under the [Functional Source License, Version 1.1,
ALv2 Future License](LICENSE) (FSL-1.1-ALv2). You can read, run, modify and
self-host the code under the terms of that license, as long as you are not
offering it (or a substantially similar product) as a competing commercial
service. Each release becomes available under the Apache License, Version 2.0
two years after that release.

## Pull requests

External pull requests are welcome. A few ground rules keep review fast:

- One topic per pull request. Unrelated changes bundled together are harder
  to review and more likely to be asked to split.
- Pull requests are squash-merged, so your commit messages inside the branch
  don't need to be pristine, but the PR title and description should clearly
  explain the change.
- Commit messages and PR descriptions are written in English.
- CI must pass before a PR is merged. Pull requests land through a merge queue,
  which runs the full CI gate on each one on top of `main` before merging it.
- Changes to behavior need tests. A bug fix should include a test that would
  have caught the bug; a new feature should include tests for it.
- Changes users can see need docs. `.claude/docs-map.ts` names the pages under
  `docs/` that each code path feeds; update them in the same PR. The `guards`
  check runs `bun run check:docs` and fails a PR that changes a mapped path
  without its page. A change with no user-visible effect adds a line
  `Docs-skip: <reason>` to the PR description.

For anything beyond a small fix, consider opening an issue first to discuss
the approach before investing time in an implementation.

## Setting up a local dev environment

```bash
# Install dependencies
bun install

# Start PostgreSQL + Redis + MeiliSearch + the object store (docker compose based)
bun run infra:up

# Create and migrate the dev database
bun run db:reset

# Start the dev server (API + frontend); this auto-seeds the QA dataset on first run
bun run dev
```

The dev compose stack binds fixed host ports (`5432`, `6379`, `7700`, `9000`),
so it conflicts with another Postgres/Redis/MeiliSearch/object-store stack
already running on those ports on your machine.

Useful checks before opening a PR:

```bash
bun run check       # Biome lint + format check
bun run typecheck    # TypeScript check across all workspaces
bun run test:unit    # Backend + frontend unit tests
```

See [README.md](README.md) for the full list of scripts and the project
structure.

## Releases (maintainers)

There are two channels ([docs](docs/admin/upgrades.md#choose-a-channel)).
`.github/workflows/nightly.yml` publishes a nightly once a day, unattended, from the
newest `main` commit whose `ci` run is green. One nightly per UTC day: its tag
`nightly-YYYYMMDD` never moves, so a newer commit waits for the next day's run.
`gh workflow run nightly.yml` starts one by hand, under the same rules.

To promote a nightly to a release:

1. Let the nightly run on the maintainers' instances first. That soak is the
   difference between the channels.
2. Find its commit: `git rev-parse "nightly-YYYYMMDD^{commit}"`. For a nightly
   already pruned, use the short sha in the version it reports.
3. Tag that commit, annotated: `git tag -a vX.Y.Z <commit> -m "vX.Y.Z"` (add
   `-m "Security: yes"` for a [security fix](docs/admin/upgrades.md#mark-a-release-as-a-security-fix)),
   then `git push origin vX.Y.Z`.
4. Approve the `release` environment when `release.yml` asks. It publishes `:vX.Y.Z`,
   `:latest` and the GitHub Release.

The release's notes are the top section of `docs/release-notes.md` in the tagged
commit, not in `main`. Land that section before the nightly you mean to promote is
cut: a later commit would not be in the tag, and the release would repeat the
previous notes.

## Secret scanning

A commit pushed to a pull request stays public for good, even after a force
push, so secrets are stopped before they leave your machine. `bun install` wires
two git hooks from `scripts/git-hooks/`. They need
[gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`, or a
release binary) and refuse to run without it:

- `pre-commit` scans what you staged, in well under a second for a normal commit.
- `pre-push` scans every commit the push adds, merge commits and commit messages
  included. It also refuses any address you listed in the local git config
  `liaison.blockedEmails` on an author, a committer or in a message, for instance
  a personal address you don't want public:
  `git config --global --add liaison.blockedEmails you@example.com`.

The `gitleaks` check in CI scans every commit of a pull request the same way,
and `bun run pr:land` refuses to queue a PR until it passes; the merge queue
scans the commits it adds the same way.

**When it flags a real secret:** rotate it. Removing it from the newest commit
isn't enough, since every commit is scanned and published: rewrite the branch so
no commit holds it.

**When it flags a false positive:** add an entry to `.gitleaks.toml` for that
exact string, pinned to its file when you can, with a comment saying why it isn't
a credential, in the same pull request. Never widen a rule or a path to get a
green check. `gitleaks:allow` comments are ignored on purpose, so review sees
every exception in one file.

## The Contributor License Agreement (CLA)

Every external contributor needs to sign the [Contributor License
Agreement](CLA.md) before a pull request can be merged. This is what lets the
project be dual-licensed (including under commercial terms) without every
contributor having to be tracked down individually later.

Signing is handled by a bot: open your first pull request and a comment will
appear with a link to sign the CLA electronically. The bot re-checks
automatically once you've signed, and you only need to do it once.

## Bug reports

Bug reports are welcome. Open an issue with the version you run, what you did,
what you expected and what happened instead.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).

## Building your own app

Extending Liaison with your own plugin app needs no change to this repository.
See [`docs/app-development.md`](docs/app-development.md).

## Commercial inquiries

For commercial licensing and other business inquiries, contact
mathieu@liaison.sh.
