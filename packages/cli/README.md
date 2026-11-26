# @liaison/cli

The remote `liaison` command line: sign in to your Liaison organization from a terminal, build and publish your organization's own apps, and apply roles, agents, skills and routines from a file, over HTTPS. It needs no server access and carries no server code.

```
liaison login --host https://<your Liaison address>
liaison apps init visit-log --title "Visit log"
cd visit-log
liaison apps push && liaison apps test && liaison apps publish --wait
```

Every publish waits for a person's approval in Liaison. Full guide: [docs/developers/cli.md](../../docs/developers/cli.md) (published at liaison.sh/docs/developers/cli).

Build from this folder: `bun install && bun run build` writes `dist/liaison.js` (Node.js 20+ or Bun); `npm pack` makes an installable tarball.
