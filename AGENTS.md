# Instructions for coding agents

Read the one that matches what you were asked to do.

- **Setting up Liaison for a company or team** (deploy, install, self-host,
  "set up Liaison for my company"): follow
  [.claude/skills/setup-liaison/SKILL.md](.claude/skills/setup-liaison/SKILL.md)
  step by step. It takes a new instance from a fresh clone to a running org
  that knows the company: about 9 minutes for a trial on your own machine (your knowledge and agents, no mailbox yet, so nobody else can sign in), or about 15 minutes for the basic onboarding on a server (the mail sender, Google sign-in, your team, the support inbox and your company knowledge), and up to about 2 hours of your own time for a full onboarding on a server with every connector, with every console step spelled out.
- **Building an app for one organization** ("build me an app that does X
  for our org") from an MCP connection to a Liaison org, with no server of
  your own: follow
  [.claude/skills/building-an-org-app/SKILL.md](.claude/skills/building-an-org-app/SKILL.md).
  An app inside a fork of this repo, installed by a server's operator, follows
  [.claude/skills/creating-an-app/SKILL.md](.claude/skills/creating-an-app/SKILL.md).
- **Contributing to the code** (features, fixes, tests, apps): follow
  [.claude/CLAUDE.md](.claude/CLAUDE.md) and the skills it points to. Docs are
  part of done: update the pages [.claude/docs-map.ts](.claude/docs-map.ts)
  names for the paths you changed, and run `bun run check:docs`.
