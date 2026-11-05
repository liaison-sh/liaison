#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PUSH NOTIFICATION MATRIX (spec-push.md S7). For each case: set the
// recipient's settings through the API, put each surface in its state, fire a
// real producer as the sender, then read the recipient's delivery rows and
// receipts for up to 30 s and judge every surface (lib/engine.ts). Settings
// are restored after each case. Reports: report-<ts>-run<k>.{json,md}.
//
//   bun qa/notifications/matrix.ts --dry-run
//   bun qa/notifications/matrix.ts --surfaces=web --only=M1-direct-computer-on
//
// See README.md for the environment, the one-time device setup and the human
// cells.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ApiClient, McpCredential, type NotificationSettingsView } from "./lib/api"
import { buildCases, controllersNeeded } from "./lib/cases"
import { type Config, ConfigError, missingForLive, parseConfig, selects, USAGE } from "./lib/config"
import {
  evaluatePhase,
  humanIsTrigger,
  humanTriggeredElapsed,
  isSettled,
  logOpensAt,
  notificationIdsFrom,
  observeWindowFrom,
} from "./lib/engine"
import { buildReport, caseStatus, renderMarkdown, renderPlan } from "./lib/report"
import { BrowserController } from "./lib/surfaces/browser"
import {
  CapabilityGap,
  type CaseThreads,
  type SurfaceController,
  sleep,
} from "./lib/surfaces/common"
import { DesktopController } from "./lib/surfaces/desktop"
import { IosSimulatorController } from "./lib/surfaces/ios"
import type {
  CaseResult,
  CellResult,
  Controller,
  MatrixCase,
  Phase,
  PhaseObservation,
  Surface,
  Trigger,
} from "./lib/types"

const POLL_MS = 1000
/** Read the log from a little before the trigger: the server clock may lead ours. */
const CLOCK_SLACK_MS = 5000
const TRIGGER_GAP_MS = 1500

interface Ctx {
  cfg: Config
  sender: ApiClient
  recipient: ApiClient
  nodevice: ApiClient | null
  threads: CaseThreads
  nodeviceDm: string | null
  controllers: Map<Controller, SurfaceController>
  /** Minted from the connections' refresh tokens as the run goes (15 min access tokens). */
  recipientMcp: McpCredential | null
  senderMcp: McpCredential | null
  log: (line: string) => void
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

// --- triggers ---

async function fire(
  ctx: Ctx,
  c: MatrixCase,
  trigger: Trigger,
  target: ApiClient,
  notes: string[],
): Promise<string[]> {
  const { sender, threads, cfg } = ctx
  const dmThread = c.recipient === "nodevice" ? ctx.nodeviceDm : threads.dm
  switch (trigger.type) {
    case "none":
      return []
    case "dm":
      if (!dmThread) throw new Error("no DM thread for this recipient")
      await sender.post(dmThread, trigger.text ?? `Push matrix ${c.id} ${Date.now()}`)
      return []
    case "mention":
      await sender.post(threads.group, `@[Recipient](user:${target.userId}) push matrix ${c.id}`)
      return []
    case "thread_reply":
      await sender.post(threads.group, `Push matrix reply ${c.id} ${Date.now()}`)
      return []
    case "notify_user":
      if (ctx.recipientMcp) {
        await target.mcpTool(ctx.recipientMcp, "kernel__notify_user", {
          summary: `Push matrix ${c.id}`,
          urgency: trigger.urgent ? 90 : 40,
        })
        return []
      }
      notes.push("agent_notification via QA inject: no MATRIX_RECIPIENT_MCP_TOKEN for notify_user")
      return [await target.qaInject(target.userId, "agent_notification", trigger.urgent)]
    case "approval":
      if (ctx.senderMcp && cfg.approvalTool) {
        await sender.mcpTool(ctx.senderMcp, cfg.approvalTool, cfg.approvalArgs)
        return []
      }
      notes.push(
        "approval_pending via QA inject: no MATRIX_SENDER_MCP_TOKEN + MATRIX_APPROVAL_TOOL",
      )
      return [await target.qaInject(target.userId, "approval_pending")]
    case "qa_inject":
      return [await target.qaInject(target.userId, trigger.kind, trigger.urgent)]
    case "test_route":
      return target.testRoute()
  }
}

// --- human cells ---

async function waitForHuman(ctx: Ctx, c: MatrixCase): Promise<boolean> {
  const marker = join(ctx.cfg.reportDir, `human-ready-${c.id}`)
  rmSync(marker, { force: true })
  ctx.log(`\n>>> HUMAN CELL ${c.id}: ${c.title}`)
  for (const line of c.human?.instructions ?? []) ctx.log(`    - ${line}`)
  ctx.log(`    Then press Enter here, or: touch ${marker}`)
  const deadline = Date.now() + ctx.cfg.humanTimeoutMs
  let entered = false
  const onData = () => {
    entered = true
  }
  if (process.stdin.isTTY) process.stdin.on("data", onData)
  try {
    while (Date.now() < deadline) {
      if (entered || existsSync(marker)) return true
      await sleep(1000)
    }
    return false
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.off("data", onData)
      process.stdin.pause()
    }
    rmSync(marker, { force: true })
  }
}

// --- one case ---

function pendingCells(c: MatrixCase, status: CellResult["status"], note: string): CellResult[] {
  return c.phases.flatMap((p) => {
    const cells = [
      ...Object.entries(p.expect).map(([surface, e]) => ({
        cell: surface,
        expected: e?.kind ?? "-",
      })),
      ...(p.router ?? []).map((r) => ({
        cell: `router:${r.channel}`,
        expected: `${r.channel}:${r.result}${r.reason ? `/${r.reason}` : ""}`,
      })),
      ...(p.deviceCheck
        ? [{ cell: `registration:${p.deviceCheck.surface}`, expected: "registered" }]
        : []),
    ]
    return cells.map((x) => ({
      caseId: c.id,
      phase: p.label,
      cell: x.cell,
      expected: x.expected,
      observed: "-",
      status,
      evidence: [],
      note,
    }))
  })
}

async function applySetup(
  ctx: Ctx,
  c: MatrixCase,
  target: ApiClient,
): Promise<() => Promise<void>> {
  const saved: NotificationSettingsView = await target.getSettings()
  const undo: Array<() => Promise<unknown>> = [() => target.restoreSettings(saved)]
  await target.setGrid(c.setup.grid)
  if (c.setup.quietHours) await target.setQuietNow()
  if (c.setup.muteThread) {
    await target.setMuted(ctx.threads.group, true)
    undo.push(() => target.setMuted(ctx.threads.group, false))
  }
  if (c.setup.appRuleOff) {
    const id = await target.addAppRule(c.setup.appRuleOff.source, c.setup.appRuleOff.kinds)
    undo.push(() => target.deleteAppRule(id))
  }
  return async () => {
    for (const u of undo.reverse()) await u().catch((e) => ctx.log(`  restore failed: ${e}`))
  }
}

async function runPhase(
  ctx: Ctx,
  c: MatrixCase,
  phase: Phase,
  index: number,
  earlier: string[][],
  target: ApiClient,
  enabled: Controller[],
  notes: string[],
): Promise<{ cells: CellResult[]; ids: string[] }> {
  const human = !!c.human
  const phaseStartedAt = Date.now()
  // States: the controllers this run drives; a TestFlight phone is the human's.
  const states = phase.states ?? {}
  for (const [name, ctl] of ctx.controllers) {
    if (human && c.human?.device === "testflight-phone" && name === "ios") continue
    await ctl.apply(states, ctx.threads)
    for (const n of ctl.takeNotes?.() ?? []) if (!notes.includes(n)) notes.push(n)
  }
  if (phase.holdMs) {
    ctx.log(`  holding ${Math.round(phase.holdMs / 1000)}s`)
    await sleep(phase.holdMs)
  }
  // What the log already holds in the slack window is an earlier case's, not this trigger's.
  const snapshot = async () =>
    new Set(
      phase.observePhase !== undefined
        ? []
        : (await target.log(new Date(Date.now() - CLOCK_SLACK_MS))).deliveries.map(
            (d) => d.notificationId,
          ),
    )
  // When the human is the trigger (he taps "Send me a test"), he may act before
  // signalling: the log opens at the announcement (at most HUMAN_LEAD_MS before
  // the signal), and the "before" snapshot is taken then.
  const humanTrigger = humanIsTrigger(phase, human, index)
  const announcedAt = Date.now()
  const announcedBefore = humanTrigger ? await snapshot() : null
  if (human && index === 0) {
    const ready = await waitForHuman(ctx, c)
    if (!ready) {
      return { cells: pendingCells(c, "human-pending", "nobody confirmed in time"), ids: [] }
    }
  }

  const before = announcedBefore ?? (await snapshot())
  const triggeredAt = Date.now()
  const opensAt = logOpensAt(humanTrigger, announcedAt, triggeredAt)
  const answered: string[] = []
  const times = phase.trigger.type === "none" ? 1 : (phase.repeat ?? 1)
  for (let i = 0; i < times; i++) {
    answered.push(...(await fire(ctx, c, phase.trigger, target, notes)))
    if (i < times - 1) await sleep(TRIGGER_GAP_MS)
  }

  const receivedCountsAsShown: Surface[] = [...(phase.receivedIsShown ?? [])]
  for (const ctl of ctx.controllers.values()) {
    if (ctl.name === "ios" && ctl.receivedIsShown(states)) receivedCountsAsShown.push("ios")
  }
  const deviceIds: PhaseObservation["deviceIds"] = {}
  for (const ctl of ctx.controllers.values()) Object.assign(deviceIds, ctl.pinnedDevices())
  if (c.group === "TF" && ctx.cfg.testflightDeviceId) deviceIds.ios = [ctx.cfg.testflightDeviceId]

  let deviceCheck: PhaseObservation["deviceCheck"]
  if (phase.deviceCheck) {
    const ctl = ctx.controllers.get(
      phase.deviceCheck.surface === "browser" ? "web" : phase.deviceCheck.surface,
    )
    if (!ctl?.deviceCheck)
      throw new CapabilityGap(`no ${phase.deviceCheck.surface} registration check`)
    deviceCheck = await ctl.deviceCheck(phase.deviceCheck, target)
  }

  // Phases that judge an earlier phase's notifications read from then on.
  const since = phase.observePhase !== undefined ? earlier[phase.observePhase] : undefined
  const sinceAt = new Date(opensAt - CLOCK_SLACK_MS)
  let obs: PhaseObservation = {
    notificationIds: since ?? [],
    deliveries: [],
    receipts: [],
    triggeredAt,
    receivedCountsAsShown,
    deviceIds,
    ...(since
      ? { windowFrom: observeWindowFrom(phaseStartedAt, triggeredAt, CLOCK_SLACK_MS) }
      : {}),
    ...(deviceCheck ? { deviceCheck } : {}),
  }
  const judged: Controller[] =
    human && c.human?.device === "testflight-phone" ? [...enabled, "ios"] : enabled
  for (;;) {
    const logSince = since ? new Date(triggeredAt - 10 * 60_000) : sinceAt
    const log = await target.log(logSince)
    const ids =
      since ?? notificationIdsFrom(answered, log.deliveries, opensAt - CLOCK_SLACK_MS, before)
    obs = { ...obs, notificationIds: ids, deliveries: log.deliveries, receipts: log.receipts }
    const elapsed = humanTrigger
      ? humanTriggeredElapsed(obs, Date.now(), triggeredAt, ctx.cfg.humanTimeoutMs)
      : Date.now() - triggeredAt
    if (isSettled(phase, obs, elapsed, judged)) break
    await sleep(POLL_MS)
  }
  return { cells: evaluatePhase(c.id, phase, obs, judged), ids: obs.notificationIds }
}

async function runCase(ctx: Ctx, c: MatrixCase): Promise<CaseResult> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const enabled = ctx.cfg.surfaces
  const notes: string[] = []
  const finish = (cells: CellResult[], error?: string): CaseResult => {
    const producerNote = [c.producerNote, ...notes].filter(Boolean).join("; ")
    return {
      id: c.id,
      group: c.group,
      title: c.title,
      ...(producerNote ? { producerNote } : {}),
      cells,
      status: caseStatus({ cells, ...(error ? { error } : {}) }),
      startedAt,
      durationMs: Date.now() - started,
      ...(error ? { error } : {}),
    }
  }

  if (c.human && !ctx.cfg.awaitHuman) {
    return finish(pendingCells(c, "human-pending", "human cell: run with --await-human"))
  }
  const missing = controllersNeeded(c).filter((n) => !enabled.includes(n))
  if (missing.length > 0) {
    return finish(pendingCells(c, "skipped", `needs surface(s) ${missing.join(", ")}`))
  }
  const target = c.recipient === "nodevice" ? ctx.nodevice : ctx.recipient
  if (!target) {
    return finish(pendingCells(c, "skipped", "needs MATRIX_NODEVICE_EMAIL / _PASSWORD"))
  }

  let restore: (() => Promise<void>) | null = null
  const cells: CellResult[] = []
  const ids: string[][] = []
  try {
    restore = await applySetup(ctx, c, target)
    for (const [i, phase] of c.phases.entries()) {
      ctx.log(`  ${c.id} phase ${i + 1}: ${phase.label}`)
      const r = await runPhase(ctx, c, phase, i, ids, target, enabled, notes)
      cells.push(...r.cells)
      ids.push(r.ids)
      if (r.cells.some((x) => x.status === "human-pending")) break
    }
    return finish(cells)
  } catch (err) {
    if (err instanceof CapabilityGap) {
      return finish([...cells, ...pendingCells(c, "skipped", err.message)])
    }
    return finish(cells, (err as Error).message)
  } finally {
    await restore?.()
  }
}

// --- the run ---

async function main(): Promise<number> {
  let cfg: Config
  try {
    cfg = parseConfig(process.argv.slice(2), process.env)
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err)
    console.error(USAGE)
    return 2
  }
  if (process.argv.includes("--help")) {
    console.log(USAGE)
    return 0
  }
  const cases = buildCases(cfg.surfaces).filter((c) => selects(cfg.only, c.id, c.group))
  if (cfg.dryRun) {
    console.log(renderPlan(cases, cfg.surfaces))
    console.log(`\nTarget ${cfg.baseUrl}; ${cfg.runs} run(s); reports to ${cfg.reportDir}`)
    return 0
  }
  const missing = missingForLive(cfg)
  if (missing.length > 0) {
    console.error(`Missing for a live run: ${missing.join(", ")}`)
    return 2
  }
  mkdirSync(cfg.reportDir, { recursive: true })
  const log = (line: string) => console.log(line)
  const sender = new ApiClient(cfg.baseUrl, cfg.sender!)
  const recipient = new ApiClient(cfg.baseUrl, cfg.recipient!)
  const nodevice = cfg.nodevice ? new ApiClient(cfg.baseUrl, cfg.nodevice) : null
  await sender.login()
  await recipient.login()
  if (nodevice) await nodevice.login()
  const runTag = stamp()
  const threads: CaseThreads = {
    dm: await sender.directThread(recipient.userId),
    group: await sender.groupThread(recipient.userId, "Push matrix (QA)"),
  }
  // The channel is reused across runs: undo a mute an aborted run left behind.
  await recipient.setMuted(threads.group, false)
  const nodeviceDm = nodevice ? await sender.directThread(nodevice.userId) : null
  log(`Threads: dm ${threads.dm}, group ${threads.group}`)

  const controllers = new Map<Controller, SurfaceController>()
  // Only the controllers the selected cases drive: a run of TestFlight cells
  // (the owner's phone) must not require or touch the simulator.
  const needed = new Set(cases.flatMap((c) => controllersNeeded(c)))
  if (cfg.surfaces.includes("ios") && needed.has("ios")) {
    controllers.set("ios", new IosSimulatorController(cfg.ios, recipient, cfg.baseUrl))
  }
  if (cfg.surfaces.includes("desktop") && needed.has("desktop"))
    controllers.set("desktop", new DesktopController(cfg.desktop))
  if (cfg.surfaces.includes("web") && needed.has("web")) {
    controllers.set("web", new BrowserController(cfg.web, cfg.webUrl, cfg.recipient!, recipient))
  }
  for (const ctl of controllers.values()) {
    log(`Setting up ${ctl.name}...`)
    await ctl.setup()
  }
  const ctx: Ctx = {
    cfg,
    sender,
    recipient,
    nodevice,
    threads,
    nodeviceDm,
    controllers,
    recipientMcp: cfg.recipientMcp ? new McpCredential(cfg.baseUrl, cfg.recipientMcp) : null,
    senderMcp: cfg.senderMcp ? new McpCredential(cfg.baseUrl, cfg.senderMcp) : null,
    log,
  }

  let allPass = true
  try {
    for (let run = 1; run <= cfg.runs; run++) {
      const startedAt = new Date().toISOString()
      const results: CaseResult[] = []
      log(`\n=== Run ${run}/${cfg.runs}: ${cases.length} cases ===`)
      for (const c of cases) {
        log(`${c.id}: ${c.title}`)
        const r = await runCase(ctx, c)
        results.push(r)
        log(`  -> ${r.status}${r.error ? ` (${r.error})` : ""}`)
      }
      const report = buildReport({
        runId: `${runTag}-run${run}`,
        target: cfg.baseUrl,
        startedAt,
        finishedAt: new Date().toISOString(),
        surfaces: cfg.surfaces,
        run,
        runs: cfg.runs,
        cases: results,
      })
      const base = join(cfg.reportDir, `report-${runTag}-run${run}`)
      writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`)
      writeFileSync(`${base}.md`, renderMarkdown(report))
      log(
        `Run ${run}: ${report.verdict} (${report.totals.match} match, ${report.totals.mismatch} mismatch, ${report.totals.skipped} skipped, ${report.totals["human-pending"]} human-pending, ${report.totals.error} error) -> ${base}.md`,
      )
      // S7: a mismatch restarts the count; there is no point in a second run.
      if (!report.pass) {
        allPass = false
        break
      }
    }
  } finally {
    for (const ctl of controllers.values()) await ctl.teardown().catch(() => {})
  }
  return allPass ? 0 : 1
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err)
      process.exit(3)
    },
  )
}
