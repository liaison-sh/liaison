# Security Policy

## Supported versions

Security fixes land on `main` first and ship in the next release. Only the
latest release of each part gets them:

- **Server**: the latest `vX.Y.Z` release (the `ghcr.io/liaison-sh/liaison`
  image and the release's `docker-compose.yml`). Until the first tagged
  release, `main` is the only supported version.
- **Desktop app**: the latest desktop release. The app updates itself; an
  older build stops getting fixes once a newer one ships.
- **Mobile app**: the latest released version.

Please upgrade to the newest release before reporting an issue, and say which
version you found it in.

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Instead, use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/liaison-sh/liaison/security) of this
repository and click "Report a vulnerability". Alternatively, email
mathieu@liaison.sh.

Please include as much detail as possible (steps to reproduce, affected
version, potential impact) so the report can be triaged quickly.

## Using AI agents safely

Liaison's agents read text written by people outside your company: inbound
email, tickets, web pages, documents, and results from connected MCP servers
and apps. Any of that text can carry instructions aimed at the model. This is
called prompt injection. No model is immune to it, and Liaison does not claim
to detect it.

What Liaison does instead is limit what a fooled agent can do:

- An agent acts with the permissions of the person it works for, enforced by
  Postgres row-level security. It cannot read or change anything that person
  cannot.
- Sensitive actions, such as customer replies, invoices, discounts and record
  merges, wait for a person to approve them. The approval shows what will run,
  and the person can edit or reject it.
- Once an agent has read outside content in a turn, any action that leaves
  your company waits for a person, even one that is normally automatic. An
  admin can switch this off under Settings, Agent Safety, at their own risk.
- Every tool call is recorded with the person, agent, routine or MCP client
  that asked for it.

What is left is up to you:

- **Use a frontier model** (the current top tier from Anthropic, OpenAI or
  Google) for any agent that reads outside input or does multi-step work.
  Smaller, cheaper models follow injected instructions more easily and make
  more mistakes. In Auto mode Liaison picks the cheapest model you have
  enabled, so choose the model explicitly for those agents. Keep small models
  for low-stakes work such as summaries and tagging.
- **Keep approvals on** for anything that leaves your company: customer
  replies, invoices, refunds, payments. Turn on automatic approval only for
  low-risk actions you have watched work for a while.
- **Read the approval before you approve it.** It is the last check between
  the model and the outside world.
- **Give agents the narrowest permissions that do the job.** An agent that
  sorts support tickets does not need access to accounting.
- **Connect only MCP servers and apps you trust.** Their tool descriptions and
  results reach the model as well.
- **Review code that node sessions produce** before you merge or run it. A node
  session runs on your own computer with your access.

If you find a way for an agent to act outside these limits, for example an
action that skips its approval or data it should not see, report it as a
vulnerability using the process above.
