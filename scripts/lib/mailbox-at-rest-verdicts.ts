// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Verdicts over the evidence that zero-access personal mailboxes keep no
// plaintext at rest: the corpus is not empty, no plaintext column, search index,
// export or control-plane surface carries mail content, and a summary that
// exits non-zero on any failure.
//
// Pure functions over counts. The local end-to-end lane evaluates its evidence
// with these, and so does the operator's production assertion tool, so the two
// cannot drift apart. Every check is written so that it CAN fail: a zero-row
// corpus, an empty probe list or an export without ciphertext is a failure,
// never a vacuous pass.

export interface Verdict {
  /** Stable id, e.g. "V9a.non-vacuity". Used by the runbook and the ledger. */
  id: string
  /** The success criterion it serves, e.g. "SC1, SC2". */
  criterion: string
  status: "pass" | "fail"
  detail: string
  /** V10 only: the state write, for a human to run. Never executed here. */
  suggestedSql?: string
}

export function pass(id: string, criterion: string, detail: string): Verdict {
  return { id, criterion, status: "pass", detail }
}
export function fail(id: string, criterion: string, detail: string): Verdict {
  return { id, criterion, status: "fail", detail }
}

/** The FIRST check, and the one that stops every other check being vacuous. */
export function assertNonVacuousCorpus(readyMessageCount: number): Verdict {
  const id = "V9a.non-vacuity"
  const criterion = "SC1, SC2"
  if (!Number.isFinite(readyMessageCount) || readyMessageCount <= 0) {
    return fail(
      id,
      criterion,
      `the probe found zero ready personal-mailbox messages (${String(readyMessageCount)}). ` +
        "That is a HARD FAILURE, not a pass: every plaintext assertion below is " +
        "trivially satisfied by an empty result set. Check the connection targets " +
        "the Patroni cluster and not the vestigial liaison-postgres-1 container.",
    )
  }
  return pass(id, criterion, `${readyMessageCount} ready personal-mailbox messages under test`)
}

export interface PlaintextCounts {
  /** Rows in app_mail.messages that are ready but not fully sealed. */
  messages: number
  conversations: number
  drafts: number
  /** Rows whose raw_headers carry a key outside the allowlist. */
  rawHeaders: number
}

export function assertPlaintextColumnsClean(counts: PlaintextCounts): Verdict[] {
  const rows: Array<[string, string, number]> = [
    ["V9a.messages", "SC1, SC2", counts.messages],
    ["V9a.conversations", "SC1, SC2", counts.conversations],
    ["V9a.drafts", "SC1, SC2", counts.drafts],
    ["V9a.raw_headers", "SC2", counts.rawHeaders],
  ]
  return rows.map(([id, criterion, count]) =>
    Number.isFinite(count) && count === 0
      ? pass(id, criterion, "0 offending rows over the whole mailbox, no LIMIT")
      : fail(id, criterion, `${String(count)} offending rows`),
  )
}

export interface MeiliProbe {
  indexUid: string
  phrase: string
  hits: number
}

export function assertMeiliClean(probes: MeiliProbe[]): Verdict {
  const id = "V9b.meili"
  const criterion = "SC4"
  if (probes.length === 0) {
    return fail(id, criterion, "no index was searched: that is absence of evidence, not a pass")
  }
  const hits = probes.filter((p) => p.hits > 0)
  if (hits.length > 0) {
    const where = hits.map((h) => `${h.indexUid}:"${h.phrase}"=${h.hits}`).join(", ")
    return fail(id, criterion, `plaintext is searchable in prod Meili: ${where}`)
  }
  const indexes = new Set(probes.map((p) => p.indexUid))
  const phrases = new Set(probes.map((p) => p.phrase))
  const detail = `${phrases.size} phrases across ${indexes.size} indexes, zero hits`
  // The CANONICAL index, not a `thread` one.
  //
  // This check used to require an index named `thread`, and no deployment has
  // ever had one: `infra/search/client.ts` names exactly one index,
  // `liaison_search` (prefixed per deployment by `MEILI_INDEX_PREFIX`), and
  // every searchable entity, thread titles and mail conversations included, is
  // a document in it. The local rehearsal of this sweep found the requirement
  // unsatisfiable against a real Meilisearch. Requiring a name that cannot
  // exist is worse than requiring nothing: the operator meets a FAIL that is
  // not a leak, at the step where the temptation to weaken the check is
  // highest. What the requirement was protecting is that the index carrying
  // thread titles was actually searched, so that is what it now says.
  if (![...indexes].some((uid) => uid.endsWith("liaison_search"))) {
    return fail(
      id,
      criterion,
      `${detail}, but the canonical liaison_search index was NOT among them: ${[...indexes].join(", ")}`,
    )
  }
  if (phrases.size < 5) {
    return fail(id, criterion, `${detail}, fewer than the five distinct phrases SC4 requires`)
  }
  return pass(id, criterion, detail)
}

export interface ExportEvidence {
  phraseCounts: Record<string, number>
  /** Occurrences of a ciphertext column in the decompressed artifact. */
  ciphertextMatches: number
}

export function assertExportArtifact(evidence: ExportEvidence): Verdict {
  const id = "V9c.export"
  const criterion = "SC5"
  const entries = Object.entries(evidence.phraseCounts)
  if (entries.length === 0) {
    return fail(id, criterion, "no phrase was searched for in the artifact")
  }
  const present = entries.filter(([, n]) => n > 0)
  if (present.length > 0) {
    return fail(
      id,
      criterion,
      `the export carries plaintext: ${present.map(([p, n]) => `"${p}"=${n}`).join(", ")}`,
    )
  }
  if (!(evidence.ciphertextMatches > 0)) {
    return fail(
      id,
      criterion,
      "the export carries no ciphertext column at all. An export that silently " +
        "produced nothing must fail, not pass.",
    )
  }
  return pass(
    id,
    criterion,
    `${entries.length} phrases absent, ${evidence.ciphertextMatches} ciphertext matches present`,
  )
}

export interface ControlPlaneCounts {
  messagesMetadata: number
  auditLog: number
  pendingEvents: number
  approvalRequests: number
  threadTitles: number
  /** kernel.files derivatives (thumbnail_key, analysis_summary) on mail rows. */
  fileDerivatives: number
  /** Redis keys whose value carried a phrase. */
  redisKeys: number
}

const CONTROL_PLANE_LABELS: Array<[keyof ControlPlaneCounts, string]> = [
  ["messagesMetadata", "kernel.messages.metadata"],
  ["auditLog", "kernel.audit_log.changes"],
  ["pendingEvents", "kernel.pending_events.payload"],
  ["approvalRequests", "kernel.approval_requests.tool_params/current_payload"],
  ["threadTitles", "kernel.threads.title"],
  ["fileDerivatives", "kernel.files derivatives"],
  ["redisKeys", "redis keyspace"],
]

export function assertControlPlaneClean(counts: ControlPlaneCounts): Verdict {
  const id = "V9e.control-plane"
  const criterion = "SC13"
  const dirty = CONTROL_PLANE_LABELS.filter(([key]) => {
    const n = counts[key]
    return !Number.isFinite(n) || n !== 0
  })
  if (dirty.length > 0) {
    return fail(
      id,
      criterion,
      `mail content in ${dirty.map(([k, label]) => `${label}=${String(counts[k])}`).join(", ")}`,
    )
  }
  return pass(id, criterion, `${CONTROL_PLANE_LABELS.length} control-plane surfaces, all zero`)
}

/** Count each phrase's occurrences in a blob of text. */
export function countPhrasePresence(text: string, phrases: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const phrase of phrases) {
    if (phrase.length === 0) continue
    let count = 0
    let from = 0
    for (;;) {
      const at = text.indexOf(phrase, from)
      if (at < 0) break
      count++
      from = at + phrase.length
    }
    out[phrase] = count
  }
  return out
}

export function summarize(verdicts: Verdict[]): { exitCode: number; text: string } {
  const lines = verdicts.map(
    (v) =>
      `${v.status === "pass" ? "PASS" : "FAIL"}  ${v.id.padEnd(22)} ${v.criterion.padEnd(10)} ${v.detail}`,
  )
  const failed = verdicts.filter((v) => v.status === "fail")
  lines.push("")
  lines.push(`${verdicts.length - failed.length} passed, ${failed.length} failed`)
  const sql = verdicts.find((v) => v.suggestedSql)?.suggestedSql
  if (sql) {
    lines.push("")
    lines.push("State write for a human to run (this script never writes):")
    lines.push(`  ${sql}`)
  }
  return { exitCode: failed.length === 0 ? 0 : 1, text: lines.join("\n") }
}
