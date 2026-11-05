// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The matrix report: JSON (the record) and markdown (what a person reads),
// one row per cell, expected vs observed with the evidence ids. Pass rule
// (S7): every cell matches. A run with skipped or human-pending cells is not
// complete, so it cannot pass either.

import { rollUp } from "./engine"
import {
  type CaseResult,
  type CellStatus,
  CONTROLLERS,
  type Controller,
  type MatrixCase,
  type RunReport,
} from "./types"

const STATUSES: CellStatus[] = ["match", "mismatch", "skipped", "human-pending", "error"]

export function buildReport(args: {
  runId: string
  target: string
  startedAt: string
  finishedAt: string
  surfaces: Controller[]
  run: number
  runs: number
  cases: CaseResult[]
}): RunReport {
  const totals = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<CellStatus, number>
  for (const c of args.cases) for (const cell of c.cells) totals[cell.status] += 1
  // A case that errored before any cell still counts against the run.
  for (const c of args.cases) if (c.cells.length === 0 && c.status === "error") totals.error += 1
  const evaluated = totals.match + totals.mismatch + totals.error
  // A run that leaves a surface out proves nothing about it.
  const allSurfaces = CONTROLLERS.every((s) => args.surfaces.includes(s))
  const complete = allSurfaces && totals.skipped === 0 && totals["human-pending"] === 0
  const pass = complete && evaluated > 0 && totals.mismatch === 0 && totals.error === 0
  return { ...args, totals, pass, complete, verdict: verdictOf(args.surfaces, totals, pass) }
}

/**
 * One line for the run: PASS, FAIL (a mismatch or an error), or INCOMPLETE
 * with why when nothing failed but the run cannot pass (a partial run, such as
 * the human cells on one or two surfaces). The pass rule is unchanged.
 */
function verdictOf(
  surfaces: Controller[],
  totals: Record<CellStatus, number>,
  pass: boolean,
): string {
  if (pass) return "PASS"
  if (totals.mismatch > 0 || totals.error > 0) return "FAIL"
  const why: string[] = []
  if (!CONTROLLERS.every((s) => surfaces.includes(s))) {
    why.push(`surfaces ${CONTROLLERS.join(",")} not all in this run (ran ${surfaces.join(",")})`)
  }
  for (const s of ["skipped", "human-pending"] as const) {
    if (totals[s] > 0) why.push(`${totals[s]} ${s}`)
  }
  if (why.length === 0) why.push("no cell evaluated")
  return `INCOMPLETE: ${why.join(", ")}`
}

/** Case status from its cells (an error with no cells stays an error). */
export function caseStatus(c: Pick<CaseResult, "cells" | "error">): CellStatus {
  if (c.error && c.cells.length === 0) return "error"
  return rollUp(c.cells)
}

function cellText(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

export function renderMarkdown(r: RunReport): string {
  const lines: string[] = []
  lines.push(`# Push matrix run ${r.run}/${r.runs}: ${r.verdict}`)
  lines.push("")
  lines.push(`- Run id: \`${r.runId}\``)
  lines.push(`- Target: ${r.target}`)
  lines.push(`- Surfaces: ${r.surfaces.join(", ")}`)
  lines.push(`- Started ${r.startedAt}, finished ${r.finishedAt}`)
  lines.push(
    `- Cells: ${STATUSES.map((s) => `${r.totals[s]} ${s}`).join(", ")}; complete: ${r.complete ? "yes" : "no"}`,
  )
  lines.push(
    "- Pass rule: every cell matches, nothing skipped or pending (S7); the spec needs 2 consecutive passing runs.",
  )
  lines.push("")
  lines.push("| case | phase | cell | expected | observed | status | evidence |")
  lines.push("|-|-|-|-|-|-|-|")
  for (const c of r.cases) {
    if (c.cells.length === 0) {
      lines.push(`| ${c.id} | - | - | - | ${cellText(c.error ?? "-")} | ${c.status} | - |`)
      continue
    }
    for (const cell of c.cells) {
      const ev = cell.evidence.length > 0 ? cell.evidence.map((e) => `\`${e}\``).join(" ") : "-"
      const observed = cell.note ? `${cell.observed} (${cell.note})` : cell.observed
      lines.push(
        `| ${c.id} | ${cellText(cell.phase)} | ${cell.cell} | ${cellText(cell.expected)} | ${cellText(observed)} | ${cell.status} | ${ev} |`,
      )
    }
  }
  const notes = r.cases.filter((c) => c.producerNote || c.error)
  if (notes.length > 0) {
    lines.push("")
    lines.push("## Notes")
    for (const c of notes) {
      if (c.producerNote) lines.push(`- ${c.id}: ${c.producerNote}`)
      if (c.error) lines.push(`- ${c.id}: error: ${c.error}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

/** The plan, for `--dry-run`: what each case sets, fires and expects. */
export function renderPlan(cases: MatrixCase[], surfaces: Controller[]): string {
  const lines: string[] = []
  const byGroup = new Map<string, number>()
  for (const c of cases) byGroup.set(c.group, (byGroup.get(c.group) ?? 0) + 1)
  lines.push(
    `Push matrix plan: ${cases.length} cases (${[...byGroup].map(([g, n]) => `${g} ${n}`).join(", ")}), surfaces ${surfaces.join(", ")}`,
  )
  for (const c of cases) {
    lines.push("")
    lines.push(`${c.id} [${c.group}] ${c.title}${c.human ? `  (human: ${c.human.device})` : ""}`)
    const grid = Object.entries(c.setup.grid)
      .map(([g, cells]) =>
        Object.entries(cells ?? {})
          .map(([ch, on]) => `${g}.${ch}=${on ? "on" : "off"}`)
          .join(" "),
      )
      .join(" ")
    const extra = [
      c.setup.muteThread ? "thread muted" : "",
      c.setup.appRuleOff
        ? `app rule off ${c.setup.appRuleOff.source}:${c.setup.appRuleOff.kinds.join(",")}`
        : "",
      c.setup.quietHours ? "quiet hours (explicit work hours exclude now)" : "",
    ].filter(Boolean)
    lines.push(`  setup: ${grid}${extra.length ? `; ${extra.join("; ")}` : ""}`)
    if (c.producerNote) lines.push(`  producer: ${c.producerNote}`)
    for (const h of c.human?.instructions ?? []) lines.push(`  human: ${h}`)
    c.phases.forEach((p, i) => {
      const states = Object.entries(p.states ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
      const trig =
        p.trigger.type === "qa_inject"
          ? `qa_inject(${p.trigger.kind}${p.trigger.urgent ? ", urgent" : ""})`
          : p.trigger.type === "notify_user" && p.trigger.urgent
            ? "notify_user(urgent)"
            : p.trigger.type
      const exp = Object.entries(p.expect)
        .map(
          ([s, e]) =>
            `${s}=${e ? (e.kind === "suppressed" && e.reason ? `suppressed(${e.reason})` : e.kind) : "?"}`,
        )
        .join(" ")
      const router = (p.router ?? [])
        .map((r) => `router ${r.channel}:${r.result}${r.reason ? `/${r.reason}` : ""}`)
        .join(" ")
      lines.push(
        `  ${i + 1}. ${p.label}: ${states || "(states unchanged)"}${p.holdMs ? ` hold ${Math.round(p.holdMs / 1000)}s` : ""} -> ${trig}${p.repeat ? ` x${p.repeat}` : ""}${p.observePhase !== undefined ? ` (judges phase ${p.observePhase + 1}'s notifications)` : ""}`,
      )
      lines.push(
        `     expect: ${exp || "-"}${router ? ` ${router}` : ""}${p.deviceCheck ? ` registration(${p.deviceCheck.surface}, ${p.deviceCheck.action}, ${Math.round(p.deviceCheck.withinMs / 1000)}s)` : ""}`,
      )
    })
  }
  return lines.join("\n")
}
