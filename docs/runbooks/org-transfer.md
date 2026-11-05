# Moving an organization to another server

`liaison org transfer` copies one organization, with everything it owns, from
one Liaison server to another that runs the same release. Use it to split a
server, to retire one, or to move an organization back. Each server keeps its
own `ENCRYPTION_KEY`, `BYOK_ENCRYPTION_KEY` and `JWT_SECRET`.

The organization's data never goes through a file: the export writes to its
standard output and the import reads its standard input, so you pipe one into
the other over ssh. Both sides connect with `MIGRATION_DATABASE_URL`.

The import writes with triggers off (`session_replication_role = replica`),
which only a superuser or a role granted `SET` on that parameter may do. The
bundled `docker-compose.yml` sets `MIGRATION_DATABASE_URL` to the database
owner it creates as the Postgres superuser, so nothing more is needed there.
With your own Postgres, either use its owner role, or grant it once:
`GRANT SET ON PARAMETER session_replication_role TO <migration role>;`
(PostgreSQL 15 or later).

## What moves

- Every row the organization owns: its tables, the tables that belong to it
  through another of its rows (a role's grants, a person's preferences), read
  in one consistent snapshot.
- Its search documents, vectors included, so nothing is embedded again. Both
  servers must use the same search embedder.
- Its stored secrets, re-encrypted for the target. The source decrypts each one
  with its own key and encrypts it with a one-time transfer key; the target
  re-encrypts it with its own key. It is the same re-encryption as
  `liaison keys rotate` (see [Rotating keys and secrets](key-rotation.md)).
- The marks of webhook deliveries already received, so a provider retrying one
  after the move is not processed twice.

What does not move: a two-factor setup in progress (the person starts it
again), file download links issued before the move (they expire within
minutes), and sign-ins to the organization's MCP connections, which need a
reconnect. With the plain export and import, files in object storage are
copied separately, inside the storage; the transfer agents below copy them.

An organization with its own custom apps moves with the transfer agents, which
install each app on the target before its data arrives. A demo workspace, or an
organization being deleted, is refused.

## Move an organization

1. Check the move without writing anything. On the target, run the import with
   `--dry-run`. It refuses when the two servers differ (release, an app
   version, a table's columns), when another organization on the target holds
   one of this organization's unique keys (its slug, the same Google sign-in),
   or when the organization already exists there.

   ```
   KEYS=$(liaison org transfer keys)
   { echo "$KEYS"; echo "$KEYS" | ssh source liaison org transfer export <org id> --transfer <id>; } \
     | liaison org transfer import --dry-run
   ```

2. Run the same command without `--dry-run`. The organization arrives
   `incoming`: the target serves nothing for it until the move commits.
3. To see how big a move is first, run `liaison org transfer estimate <org id>`
   on the source.
4. After the move, the source keeps its copy as `moved`. Once you no longer
   need it, write a fresh storage probe on the target, hand it to the purge on
   the source, then remove the probe:

   ```sh
   # on the target
   liaison org transfer probe-write <org id> --transfer <id> > probe.json
   # on the source, with probe.json copied over
   liaison org transfer purge-source <org id> --transfer <id> < probe.json
   # on the target
   liaison org transfer probe-clear < probe.json
   ```

   The purge refuses if the probe is visible on the source: the target was
   rebuilt or restored since the move with the source's object store, search
   index or Redis, and the purge would delete the live copy.

The transfer keys line is the first line of each side's input. Never put it in
a file, a variable that outlives the command, or an argument.

## Move it back

An import accepts an organization that already exists on the target only when
that copy is `moved` by the transfer that brought the organization to the
other server. The old copy is deleted and replaced. Any other existing copy is
refused.

## Move a live organization with the transfer agents

The steps above copy an organization that nobody is using. To move one while
its people keep working, run the two transfer agents. They copy the
organization twice while it stays live, then stop its writes for a few seconds
while they copy the last changes, and switch it over.

- On the target, `liaison org transfer agent --role target` reads commands on
  its standard input and answers on its standard output. Make it the forced
  command of an ssh key the source can use.
- On the source, run
  `liaison org transfer agent --role source <org id> --transfer <id> --target-cmd '<ssh command that starts the target agent>'`.
  Its first input line holds the control plane's address and operator key:
  `{"operator":{"control":"<webhook base>","operatorKey":"<key>"}}`. It prints
  one progress line per phase and a JSON report at the end. Exit code 0 means
  the move committed, 1 that it was aborted (the organization stays on the
  source), 3 that the control plane could not be reached for the decision.

What happens, in order:

1. **Copy while live.** The organization's rows, search documents, objects and
   custom apps go to the target, where the organization waits as `incoming`.
   A second copy brings what changed meanwhile.
2. **Drain.** For at most 30 seconds the source still accepts writes but starts
   no new agent turn, job or event for the organization, and its messages to
   the control plane are delivered. If it does not drain in time, the move is
   aborted and nothing was frozen.
3. **Freeze.** Writes are refused for the organization (reads still work). The
   last changes are copied, checked and committed. Each step has a time limit;
   a step past its limit aborts the move before the commit, so the
   organization goes back to the source instead of staying frozen:

   | Step | Target | Limit |
   |---|---|---|
   | Freeze, every server process confirms | 0.5 s | 2 s |
   | No work of the organization still running | 0.5 s | 2 s |
   | Find the rows changed since the last copy, and the queued jobs | 2 s | 4 s |
   | Apply them on the target, in one transaction | 2 s | 4 s |
   | Check nothing changed meanwhile, copy the new files | 1 s | 2 s |
   | Commit with the control plane | 1 s | 2.5 s |
   | The target serves the organization | 0.5 s | 1.5 s |
   | Clients retry (`Retry-After: 2`) | 2 s | 2 s |

4. **After the commit.** The target serves the organization and the source
   copy is `moved`. The target then re-adds the organization's queued jobs and
   schedules (each once), watches its Gmail mailboxes again with its own
   Pub/Sub topic and syncs them from where the source stopped, and disconnects
   its MCP connections: the organization's admins get one notification asking
   them to connect their MCP clients again. Search documents and files are
   compared with the source and brought level. A difference left after that
   is logged as an alert; the source copy is kept, so nothing is lost.

The control plane decides every move. The source agent renews a lease with it
every 2 seconds. If the agent stops (a crash, the server restarts) the lease
lapses after 15 seconds and the control plane aborts the move. Each server
asks the control plane every 5 seconds about an organization still draining,
frozen or incoming for more than 5 seconds. Committed: the target serves it at
once, so an agent that stops right after the commit costs about 10 seconds,
not more. Aborted: the source serves it again, and the target deletes its copy
once the organization has been incoming for 45 seconds. While the control
plane cannot be reached, the organization stays frozen, so two servers never
both accept its writes, and from 45 seconds on an alert is logged every minute.
