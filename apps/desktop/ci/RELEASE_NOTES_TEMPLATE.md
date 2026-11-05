# Desktop release notes template

> Copy this file to apps/desktop/ci/RELEASE_NOTES.md, fill it in, and delete
> this block. The release pipeline reads that path and refuses to publish a
> manifest when it is absent.
>
> The rendered text becomes the `notes` field of the updater manifest, which
> means a customer reads it inside the app, in the update prompt, on every
> machine that updates.
>
> Two rules, both enforced by apps/desktop/release-notes-template.test.ts: no
> dash punctuation (use a colon, a comma, parentheses, or two sentences), and
> plain ASCII.
>
> Keep it short. This is an update prompt, not a changelog: a customer decides
> whether to restart the app from these lines.
>
> Leave the version out. It comes from the release tag.

## What's new

- One line per change a customer can notice, written from their side.
- A fix says what stopped happening, not which function changed.
- Skip anything internal: refactors, test work, build plumbing.

## Fixed

- What was broken, and what it does now.

## Known issues

- Anything a customer may hit in this build, with the workaround if there is one.
- Remove this whole section when there is nothing to say.
