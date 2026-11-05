---
name: boards
description: The owner-facing artifacts — the proof board (cards with evidence and two verdict layers), the decision board (options the owner clicks), and the gate file (VERDICT and SIGNED lines only the owner writes) — how to build, publish, read back, back up and republish them.
phase: brainstorm, validate
---

# Boards and gates

Three shapes the owner already uses. They are the medium for every human judgement in the
flow; nothing else asks.

## Files

```
.atelier/pipelines/<id>/board/
  catalog.json               the cards
  proof/<ITEM-ID>/result.json  my verdict and evidence per card (proof board)
  proof/<ITEM-ID>/*            evidence files: png/jpg, wav/mp3, txt/log
  config.json                title, intro, facts, round note
  site/                      generated: index.html + proof/_m/<hash>.<ext>
  verdicts-<date>.json       backups of the owner's verdicts
.atelier/pipelines/<id>/qa/   the final QA board (validating section 4), same layout as board/,
                              plus brief.md (the agent brief) and README.md (the proof contract)
.atelier/pipelines/<id>/gates/<id>.md   gate files
```

The final QA board lives in `qa/`, apart from the per-phase `board/`: its own catalogue, its
own page and URL, its own verdicts.

**Keep it off `/tmp`.** A scratch directory under `/tmp` or `/private/tmp` is swept by the OS
(macOS deletes files not accessed for three days); one run lost 204 proof records overnight.
The board directory lives in the run directory above, or in a durable folder the run links
to, never only in a session scratchpad.

## Catalog

`catalog.json` is an array of cards:

```json
{"id":"T2-PUI-08","kind":"check","group":"Perform UI","title":"Macro knob moves the mapped parameter",
 "what":"Turning macro 1 changes the filter cutoff on both voices.",
 "where":"Perform view, macro row","check":"Cutoff readout follows the knob within one frame; audio RMS above 1 kHz rises.",
 "gate":"tests/e2e/perform.spec.ts:88","priority":"P0","automatable":"yes","source":"S4"}
```

The final QA board adds `"tier"` (risk or rollout stage, e.g. `T1` ships first) and
`"proof"`, the list of evidence the card requires (`["screenshot of the real surface", "test
run named X"]`), so a proving agent knows what counts before it starts.

`kind` is `check` (proof board) or `decision` (decision board). A decision card carries
`options:[{"id":"A","label":"…","recommended":true,"why":"…"}]` and `evidence` paths instead
of `check` and `gate`. `automatable: "human"` marks a card only the owner can judge.

## Proof per card

`proof/<ITEM-ID>/result.json`:

```json
{"verdict":"pass","summary":"What I did and saw, with the counts.",
 "evidence":[{"kind":"image","file":"perform-macro.png","caption":"Cutoff at 2.1 kHz after the turn"},
             {"kind":"audio","file":"macro-sweep.wav","caption":"Sweep, 4 s"},
             {"kind":"text","file":"test.log","caption":"e2e run, 12 passed"}],
 "defects":[{"text":"Second voice lags one frame","status":"fixed 9a1c2f0"}],
 "by":"opus proof agent, area Perform"}
```

Verdicts: `pass` (proven) · `fail` (defect found) · `partial` · `human` (needs the owner's
hands) · `blocked` · `untested`. Evidence is evidence: a screenshot of a number is not a
measurement; the log with the number is.

## Agent brief and proof contract (final QA board)

Every proving agent gets the same two files before its card list: `qa/brief.md` (how to take
a card: read what, where, check, gate and proof; open the gate code when the check is
ambiguous; produce the required proof; write `result.json`; report one line per card) and
`qa/README.md` (the proof contract from validating 4.2, the drivers and tools of this
project, how to reach its backends and devices, the hard rules: one heavy job at a time, no
destructive git, no commits by proving agents, never print secrets, restore any state you
change). Writing them once keeps every proof consistent, however many there are; each agent prompt then only
names its cards and what changed since the last wave.

## Build and publish

```bash
python3 "$P/scripts/proof-board.py" .atelier/pipelines/<id>/board
```

writes `board/site/index.html` and the media it references (images to jpg, audio to mp3,
text inlined and capped; identical media published once). Then publish with the Artifact
tool: `file_path` the page, `files` mapping `proof/_m/*` from the site dir, and
`capabilities: {db: {}}` on the first publish (load the `artifact-capabilities` skill before
passing capabilities). Republish to the same URL for every round; the owner's verdicts live
in the database, not in the page, so a republish keeps them.

**Look before you publish.** Render the built page at desktop and phone width and look at
it: every card's buttons and note field must be usable (the note spans the card), nothing
overflows, and the page reads as the kind of board it is. With a headless browser at hand,
`node "$P/scripts/board-layout-check.cjs" board/site/index.html` (env
`ATELIER_PLAYWRIGHT_CORE`, `ATELIER_HEADLESS_SHELL`) fails on a squeezed note field. A board
the owner cannot fill in costs a round; a look costs a minute.

Large boards: a publish carries at most 255 files and a version at most 512, so publish the
page with the first chunk of media (with `capabilities`), then the rest in chunks of 250 with
`url`, and on a later round publish only the media that changed (keep the list of media
already published next to the board). Media go as jpg and mp3; text is inlined; no ESC bytes
in inlined logs.

Each card shows my verdict frozen in the page and offers the owner three buttons (ok, issue,
skip) plus a note; a decision card offers its options. The page writes to the `verdicts`
collection, one document per card id: `{id, verdict, note, at}` (for decisions, `verdict`
is the option id).

## Read back

- `read_db` with `db_op:"list"` on `verdicts` (page with `next_cursor`), or `query` ordered by
  `at` descending to see what changed since the last round.
- Owner notes often arrive with `verdict:null`: read the note, it is the verdict.
- Every write back to the database is pinned with `if_version` from the document you read;
  an unpinned batch silently writes nothing when a version moved.
- Back up the verdicts to `board/verdicts-<date>.json` after every round. One republish
  under a new account killed a link once; the verdicts were restored from the backup with a
  `write_db` batch.
- Comment threads on the board are design rulings: reply with what you did, then resolve
  only the threads you acted on.

## The round

Fix every `issue` card (red-then-green test, mutation check), redeploy where the surface is
deployed, re-prove the affected cards, rebuild, republish as the next version, note the
version and the tally in the ledger (`v7: 33 pass, 2 fail, 16 partial, 16 human, 55
blocked`). Stop when every card has an owner verdict; list the rest as open.

## The decision board (Brainstorm)

Same generator, `kind: decision`. One card per choice that has real alternatives, with your
recommendation marked and the evidence attached (a mock, a measurement, a datasheet excerpt).
The owner clicks; you read the choices back and write them into `decisions.md` as `D<n>`
entries with the option chosen and the alternatives rejected. A prototype that is a page in
itself (a pixel-faithful mock with candidate states) is published as its own artifact and
pinned by URL and version label in the spec.

## Gate files

`gates/<id>.md`, for a decision only the owner can close during Execute or Validate:

```
# G-P3-2 — Which headroom figure ships

Question: …
Options: A (recommended) …  B …  C …
Evidence: <paths, counts, a chart>
Artifact URL: <if a page helps decide>
Blocks: T14, T15. Continues meanwhile: everything else in P3.
Queued: 2026-09-22T14:03Z

VERDICT:
SIGNED:
```

Only the owner writes the last two lines, in the file or by dictating them in chat, which you
then transcribe verbatim with the date. Never write, edit or fabricate a sign-off. The loop
polls the file between tasks and keeps working on what the gate does not block. A gate that
blocks the whole flow is the one case where `awaiting:"user"` is set outside Brainstorm.

When Frame's echo shows `ATELIER_AUTONOMY=autonomous` (a host runs the session unattended), follow atelier.md §0b instead: the gate file is still written for the owner with VERDICT and SIGNED blank, since an autonomous run never writes them, and the run proceeds on the recommended option without setting `awaiting:"user"`.

## Privacy

Tracked run docs and boards carry no serials, licence keys, provisioning ids, customer data
or a real user's project contents. Refer to records by role.
