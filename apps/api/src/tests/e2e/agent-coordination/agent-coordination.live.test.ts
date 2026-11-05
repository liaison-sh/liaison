// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T15 to P3b-T18b: the agent coordination slice proven with REAL models.
//
// Every agent turn here runs on Gemini Flash-Lite through the production
// provider layer, through the production dispatch, and writes real rows. Every
// assertion below reads those rows back: the structure is judged by the
// database, never by a mock and never by the judge model. The judge scores the
// ANSWER only, against a rubric that never sees an expected value.
//
// Skipped, loudly, when GOOGLE_API_KEY is absent.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { AGENT_HOP_BOUND, AGENT_TURNS_PER_ROOT_CAP } from "~/modules/threads/agent-dispatch-guard"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  AGENT_MODEL_ID,
  askAsAgent,
  type Fixture,
  financeLedgerPrompt,
  guardVerdict,
  humanSays,
  INVOICE_REFERENCE,
  INVOICE_TOTAL,
  judgeAnswer,
  judgeFallbackReason,
  judgeModelChoice,
  judgeModelUsed,
  judgePathUsed,
  K_ASK_OVERHEAD_RATIO_PERCENT,
  K_SCENARIO_TOTAL_TOKENS,
  type MessageRow,
  mention,
  readAgentParticipants,
  readCreditUsage,
  readMessages,
  readTurnUsage,
  resetSdkJudgeCall,
  seedFixture,
  setSdkJudgeCall,
  teardownFixture,
  toolCallsOf,
  toolNamesOf,
  toolResultOf,
  totalTokens,
  writeRunReport,
} from "./harness"

const GOOGLE_KEY = process.env.GOOGLE_API_KEY

if (!GOOGLE_KEY) {
  console.log(
    "[agent-coordination] SKIPPED: GOOGLE_API_KEY is not set, so no live model ran. This suite is NOT a pass.",
  )
}

/** The most agent authored links any one message sits under, itself included. */
function deepestAgentChain(rows: MessageRow[]): number {
  const byId = new Map(rows.map((r) => [r.id, r]))
  let deepest = 0
  for (const row of rows) {
    let depth = 0
    let cursor: MessageRow | undefined = row
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      if (cursor.authorType === "agent") depth += 1
      cursor = cursor.parentMessageId ? byId.get(cursor.parentMessageId) : undefined
    }
    deepest = Math.max(deepest, depth)
  }
  return deepest
}

/** Digits only, so "4,127.60 EUR" and "EUR 4127.60" read the same. */
function figures(text: string): string {
  return text.replace(/[\s, ]/g, "")
}

const ASK_TOOL = "kernel__agents_ask"
const INVITE_TOOL = "kernel__agents_invite"

describe.skipIf(!GOOGLE_KEY)("agent coordination, live models", () => {
  const created: Fixture[] = []

  async function fixture(opts: Parameters<typeof seedFixture>[0]): Promise<Fixture> {
    const f = await seedFixture(opts)
    created.push(f)
    return f
  }

  beforeAll(async () => {
    await acquireTestLock()
  })

  afterAll(async () => {
    for (const f of created) await teardownFixture(f)
    await releaseTestLock()
  })

  it("the harness seeds two live agents with distinct ceilings and no scenario", async () => {
    const scaffold = await fixture({ label: "scaffold" })
    expect(scaffold.alex.id).not.toBe(scaffold.finance.id)
    expect(scaffold.alex.ceiling).not.toEqual(scaffold.finance.ceiling)
    expect(scaffold.finance.ceiling).toContain(scaffold.invoiceScope)
    expect(scaffold.alex.ceiling).toContain(scaffold.invoiceScope)
    expect(scaffold.logistics.id).not.toBe(scaffold.finance.id)
    expect(scaffold.threadId).toBeTruthy()
  })

  it("scenario 1 personal agent asks the finance agent and returns the invoice total", async () => {
    beginScenario("scenario 1")
    const f = await fixture({
      label: "s1",
      alexCeiling: ["kernel"],
      financePrompt: financeLedgerPrompt(),
    })
    const rootId = await humanSays(
      f,
      `${mention(f.alex)} what is the total on invoice ${INVOICE_REFERENCE}?`,
    )
    const rows = await readMessages(f)

    // The ask actually happened, as a recorded tool call on Alex's turn.
    const askers = rows.filter((r) => toolNamesOf(r).includes(ASK_TOOL))
    expect(askers.some((r) => r.authorAgentId === f.alex.id)).toBe(true)

    // The question: Alex authored it, it hangs under the human turn, and it
    // names the finance agent in the content the room reads.
    const question = rows.find(
      (r) =>
        r.authorAgentId === f.alex.id &&
        r.parentMessageId !== null &&
        r.content.includes(f.finance.id),
    )
    expect(question).toBeDefined()
    expect(question?.parentMessageId).toBe(rootId)

    // The answer: the finance agent authored it, nested under the question.
    const answer = rows.find((r) => r.authorAgentId === f.finance.id)
    expect(answer).toBeDefined()
    expect(answer?.parentMessageId).toBe(question?.id)

    // The human facing reply is flattened and carries the figure only the
    // tool knew.
    const finals = rows.filter((r) => r.authorAgentId === f.alex.id && r.parentMessageId === null)
    expect(finals.length).toBeGreaterThan(0)
    const final = finals[finals.length - 1]
    expect(figures(final.content)).toContain(figures(INVOICE_TOTAL))
    recordAnswer("scenario 1", f, final)
    passScenario("scenario 1")
  }, 600_000)

  it("scenario 2 an ask outside the caller scope is withheld and reported as a category", async () => {
    beginScenario("scenario 2")
    // The gap is on the CALLER's side: Alex may not read invoices, so the
    // delegation cannot hand the finance agent a capability Alex lacks.
    const f = await fixture({ label: "s2", alexCeiling: ["kernel"] })
    await humanSays(f, `${mention(f.alex)} what is the total on invoice ${INVOICE_REFERENCE}?`)
    const rows = await readMessages(f)

    const asker = rows.find(
      (r) => r.authorAgentId === f.alex.id && toolNamesOf(r).includes(ASK_TOOL),
    )
    expect(asker).toBeDefined()
    const result = toolResultOf(asker as MessageRow, ASK_TOOL) as {
      withheldCapabilities?: string[]
    } | null
    const withheld = result?.withheldCapabilities ?? []
    expect(withheld.length).toBeGreaterThan(0)
    for (const entry of withheld) {
      // A category, never a scope string and never a tool name.
      expect(entry).not.toContain(":")
      expect(entry).not.toContain("__")
      expect(entry.toLowerCase()).not.toContain("invoice_total")
    }

    const finals = rows.filter((r) => r.authorAgentId === f.alex.id && r.parentMessageId === null)
    const final = finals[finals.length - 1]
    expect(final).toBeDefined()
    expect(figures(final.content)).not.toContain(figures(INVOICE_TOTAL))
    // No scope STRING and no tool name. The English word "scope" in a decline
    // is prose, not a disclosure: what A14 forbids is naming the capability.
    const lower = final.content.toLowerCase()
    expect(lower).not.toContain(f.invoiceScope)
    expect(lower).not.toContain("app_ledger")
    expect(lower).not.toContain("invoice_total")
    expect(lower).not.toContain("ledger__")
    recordAnswer("scenario 2", f, final)
    passScenario("scenario 2")
  }, 600_000)

  it("scenario 3 a two hop chain stops at the hop bound", async () => {
    beginScenario("scenario 3")
    const f = await fixture({
      label: "s3",
      // No invoice reach for anybody in this room: the chain is the ONLY way
      // to an answer, so a chain the guard cuts has to end in a refusal.
      alexCeiling: ["kernel"],
      alexPrompt: [
        "You are Alex, a personal assistant.",
        'Whatever the question is, call agents_ask with agentHandle "@logistics" and pass the question on.',
        '"@logistics" is the ONLY agent you may ask. Never ask "@finance" and never ask anybody else.',
        "You hold no records of your own and must never state a figure, an amount or a date yourself.",
        'When the answer does not come back, reply with exactly this sentence and nothing else: "I could not get an answer to that."',
        "Otherwise reply in one sentence reporting exactly what came back.",
      ].join(" "),
      logisticsPrompt: [
        "You are the logistics agent.",
        'Whatever the question is, call agents_ask with agentHandle "@finance" and pass the question on.',
        'If that call is refused, reply with exactly this sentence and nothing else: "I could not pass the question on."',
      ].join(" "),
    })
    await humanSays(f, `${mention(f.alex)} what is the total on invoice ${INVOICE_REFERENCE}?`)
    const rows = await readMessages(f)

    // Exactly two agents ran a turn: the bound is on the third dispatch.
    const authors = new Set(
      rows.filter((r) => r.authorAgentId !== null).map((r) => r.authorAgentId as string),
    )
    expect(authors.has(f.alex.id)).toBe(true)
    expect(authors.has(f.logistics.id)).toBe(true)

    // THE invariant the hop bound exists for: no message in the room sits
    // under more than AGENT_HOP_BOUND agent authored links. Alex is free to
    // ask a second agent itself at hop 0, and does; what it cannot do is let
    // the agent it asked relay the question a third time.
    expect(deepestAgentChain(rows)).toBeLessThanOrEqual(AGENT_HOP_BOUND)

    // The third ask was refused as hop_bound, by the guard, before it could
    // post a question: no message in the room names the finance agent.
    // The guard's verdict on the chain the live run actually wrote. A model
    // may decline to ask; the guard may not decline to refuse, so this reads
    // the persisted chain and asks the production guard about the next link.
    const question = rows.find((r) => r.authorAgentId === f.alex.id && r.parentMessageId !== null)
    expect(question).toBeDefined()
    const verdict = await guardVerdict(f, {
      parentMessageId: question?.id ?? null,
      callerAgentId: f.logistics.id,
      calleeAgentId: f.finance.id,
      questionText: `${mention(f.finance)} what is the total on invoice ${INVOICE_REFERENCE}?`,
    })
    // The exact predicate `agents_ask` applies before it posts anything: the
    // question about to be written is the next agent link in the chain, so a
    // chain already one link deep puts it AT the bound and it is refused.
    // An ask is refused when the guard refuses it OUTRIGHT, or when the guard
    // allows the chain but the question about to be posted would be the next
    // agent link at or past the bound: that `hopDepth + 1` is the predicate
    // `agents_ask` applies before it posts anything. Both branches occur here
    // (a busy root also trips the per root cap), and both are the bound doing
    // its job, so the assertion is the disjunction and the reason is recorded.
    console.log(`[p3b-guard] third link verdict ${JSON.stringify(verdict)}`)
    const askWouldBeRefused = verdict.allowed === false || verdict.hopDepth + 1 >= AGENT_HOP_BOUND
    expect(askWouldBeRefused).toBe(true)
    guardVerdictReason = verdict.allowed === false ? verdict.reason : "hop_bound (at the ask)"

    // The relayed ask HAPPENED, and it was refused. Unconditional: the
    // logistics prompt says to pass every question on, so a run in which it
    // never called the tool exercised no relay at all and is a failure of the
    // scenario, never a pass of it. WHICH refusal fired is recorded rather than
    // pinned: a chain this deep is also at the per root turn cap, and either
    // guard refusing it is the system working.
    const refused = rows.find(
      (r) => r.authorAgentId === f.logistics.id && toolNamesOf(r).includes(ASK_TOOL),
    )
    if (!refused) {
      throw new Error(
        "scenario 3 FAILED: the logistics agent never called agents_ask, so no relay was attempted and the hop bound was never exercised. A model that declines to ask fails this scenario; it does not pass it quietly.",
      )
    }
    const relayResult = toolResultOf(refused, ASK_TOOL) as {
      asked?: boolean
      reason?: string
    } | null
    expect(relayResult?.asked).toBe(false)
    expect(["hop_bound", "root_turn_cap", "duplicate_ask", "chain_too_deep"]).toContain(
      relayResult?.reason ?? "none",
    )
    thirdLinkReason = relayResult?.reason ?? "not asked"
    // Nothing asserts that the finance agent was never named: Alex is free to
    // ask a second agent ITSELF at hop 0, and does. What the bound forbids is
    // the agent Alex asked relaying the question a third time, which is the
    // chain depth asserted above.

    const finals = rows.filter((r) => r.authorAgentId === f.alex.id && r.parentMessageId === null)
    recordAnswer("scenario 3", f, finals[finals.length - 1])
    passScenario("scenario 3")
  }, 600_000)

  it("scenario 4 an ask loop between two agents is cut", async () => {
    beginScenario("scenario 4")
    const f = await fixture({
      label: "s4",
      alexCeiling: ["kernel"],
      financePrompt: [
        "You are the finance agent.",
        'Whatever you are asked, call agents_ask with agentHandle "@alexs-agent" and pass the same question back.',
        'If that call is refused, reply with exactly this sentence and nothing else: "I could not pass the question on."',
      ].join(" "),
    })
    await humanSays(f, `${mention(f.alex)} what is the total on invoice ${INVOICE_REFERENCE}?`)
    const rows = await readMessages(f)

    // WHICH guard cut it, by its exact reason. hop_bound and duplicate_ask
    // are different defects if the wrong one fires.
    const financeAsk = rows
      .filter((r) => r.authorAgentId === f.finance.id)
      .flatMap(toolCallsOf)
      .find((c) => c.toolName === ASK_TOOL)
    // Unconditional: the finance prompt says to pass every question straight
    // back, so the loop is only cut if it was attempted. A run in which the
    // finance agent never asked exercised no loop and fails the scenario.
    if (!financeAsk) {
      throw new Error(
        "scenario 4 FAILED: the finance agent never called agents_ask, so no loop was attempted and no guard was exercised. A model that declines to ask fails this scenario; it does not pass it quietly.",
      )
    }
    const askEnvelope = financeAsk.result as {
      data?: { reason?: string }
      reason?: string
    } | null
    const flat = (askEnvelope?.data ?? askEnvelope) as
      | { asked?: boolean; reason?: string }
      | undefined
    expect(flat?.asked).toBe(false)
    expect(["hop_bound", "duplicate_ask"]).toContain(flat?.reason ?? "none")
    loopCutReason = flat?.reason ?? "unknown"

    // The cap holds whatever the models did.
    const agentMessages = rows.filter((r) => r.authorType === "agent")
    expect(agentMessages.length).toBeLessThanOrEqual(AGENT_TURNS_PER_ROOT_CAP)

    // Nobody asked itself: every recorded ask names a handle that is not the
    // asking agent's own.
    const handleOf = new Map([
      [f.alex.id, f.alex.handle],
      [f.finance.id, f.finance.handle],
      [f.logistics.id, f.logistics.handle],
    ])
    for (const row of rows.filter((r) => r.authorAgentId !== null)) {
      for (const call of toolCallsOf(row)) {
        if (call.toolName !== ASK_TOOL) continue
        const asked = (call.args as { agentHandle?: string } | null)?.agentHandle ?? ""
        const own = handleOf.get(row.authorAgentId as string) ?? ""
        expect(asked.replace(/^@+/, "")).not.toBe(own.replace(/^@+/, ""))
      }
    }

    const finals = rows.filter((r) => r.authorAgentId === f.alex.id && r.parentMessageId === null)
    recordAnswer("scenario 4", f, finals[finals.length - 1])
    passScenario("scenario 4")
  }, 600_000)

  it("scenario 5 an invite asks the person first: nothing is seated until they approve", async () => {
    beginScenario("scenario 5")
    inviteFixture = await fixture({
      label: "s5",
      alexPrompt: [
        "You are Alex, a personal assistant.",
        'When the person asks you to add the logistics agent to the conversation, call agents_invite with agentHandle "@logistics".',
        "Never call agents_ask. After the invite, reply in one sentence that the person has to approve adding the logistics agent.",
      ].join(" "),
    })
    const f = inviteFixture
    await humanSays(
      f,
      `${mention(f.alex)} add the logistics agent to this channel, we will be talking about deliveries all week.`,
    )
    const rows = await readMessages(f)

    // The invite was the tool the agent called...
    expect(rows.some((r) => toolNamesOf(r).includes(INVITE_TOOL))).toBe(true)
    // ...and it parked an approval for the person instead of seating anyone.
    const asks = await sql<{ status: string }[]>`
      SELECT status FROM kernel.approval_requests
      WHERE org_id = ${f.orgId} AND thread_id = ${f.threadId} AND tool_name = 'kernel:agents_invite'`
    expect(asks.map((a) => a.status)).toEqual(["pending"])
    expect(await readAgentParticipants(f)).not.toContain(f.logistics.id)
    const addedLines = rows.filter((r) => r.authorType === "system" && r.content.includes("added"))
    expect(addedLines.length).toBe(0)

    // S12: an invite starts nothing. The logistics agent has not spoken.
    expect(rows.some((r) => r.authorAgentId === f.logistics.id)).toBe(false)

    const finals = rows.filter((r) => r.authorAgentId === f.alex.id && r.parentMessageId === null)
    recordAnswer("scenario 5", f, finals[finals.length - 1])
    passScenario("scenario 5")
  }, 600_000)

  it("scenario 6 a mention after an invite answers in the channel flattened", async () => {
    beginScenario("scenario 6")
    const f = inviteFixture
    expect(f).toBeDefined()
    const before = await readMessages(f)
    const rootId = await humanSays(
      f,
      `${mention(f.logistics)} has the pallet for order 7781 been delivered yet?`,
    )
    const rows = await readMessages(f)
    const fresh = rows.filter((r) => !before.some((b) => b.id === r.id))

    // The mentioned agent answered, and its human facing turn is flattened.
    const answers = fresh.filter((r) => r.authorAgentId === f.logistics.id)
    expect(answers.length).toBeGreaterThan(0)
    for (const row of answers) expect(row.parentMessageId).toBeNull()

    // The guard allowed it at hop 0: a human's own mention has no chain.
    const verdict = await guardVerdict(f, {
      parentMessageId: null,
      callerAgentId: null,
      calleeAgentId: f.logistics.id,
      questionText: "has the pallet for order 7781 been delivered yet?",
      threadId: f.threadId,
    })
    expect(verdict.allowed).toBe(true)
    expect(verdict.allowed === true && verdict.hopDepth).toBe(0)
    expect(rootId).toBeTruthy()

    // It answered the human, not another agent: no agent mention token, and
    // the human is addressed by name.
    const answer = answers[answers.length - 1]
    recordAnswer("scenario 6", f, answer)
    expect(answer.content).not.toContain("(agent:")
    expect(answer.content).not.toContain(f.finance.handle)
    expect(answer.content).not.toContain(f.alex.handle)
    expect(answer.content).toContain(f.userName)
    passScenario("scenario 6")
  }, 600_000)

  it("scenario 7 the same question asked twice in one turn is deduped and the earlier answer returned", async () => {
    beginScenario("scenario 7")
    // The dedupe is the one coordination path a live model cannot be relied on
    // to walk: a model is free to decline to repeat itself, and a scenario
    // built on its willingness to do so proves nothing on the runs where it
    // does not. So the DECISION to ask twice is the harness's and everything
    // else is production: the guard, the callee's live turn, the persistence
    // and the answer that comes back.
    const f = await fixture({ label: "s7", financePrompt: financeLedgerPrompt() })
    // A human message that mentions nobody: it starts no turn and is only the
    // root the two asks hang under.
    const rootId = await humanSays(f, `${f.userName} here, the invoice question is coming up.`)
    const question = `what is the total on invoice ${INVOICE_REFERENCE}?`

    const first = await askAsAgent(f, {
      caller: f.alex,
      agentHandle: f.finance.handle,
      question,
      turnMessageId: rootId,
    })
    expect(first.asked).toBe(true)
    expect(first.answer).toBeTruthy()
    const afterFirst = await readMessages(f)

    const second = await askAsAgent(f, {
      caller: f.alex,
      agentHandle: f.finance.handle,
      question,
      turnMessageId: rootId,
    })
    expect(second.asked).toBe(false)
    expect(second.reason).toBe("duplicate_ask")
    // The earlier answer comes BACK, rather than nothing: a refusal that hands
    // the caller nothing is what makes a model ask a third time.
    expect(second.answer).toBe(first.answer as string)
    // And the repeat posted nothing: no second question, no second turn.
    expect((await readMessages(f)).length).toBe(afterFirst.length)

    // The judged answer for this scenario is the CALLEE's, because there is no
    // human facing turn: the harness asked, not a personal agent replying to a
    // person. It is the same shape of answer scenario 1 judges.
    const answered = afterFirst.find((r) => r.authorAgentId === f.finance.id)
    expect(answered).toBeDefined()
    recordAnswer("scenario 7", f, answered)
    passScenario("scenario 7")
  }, 600_000)

  it("the token accounting reports input and output tokens for every agent turn in a scenario", async () => {
    expect(answers.length).toBe(7)
    for (const record of answers) {
      const turns = await readTurnUsage(record.fixture)
      expect(turns.length).toBeGreaterThan(0)
      for (const turn of turns) {
        expect(turn.inputTokens).toBeGreaterThan(0)
        expect(turn.outputTokens).toBeGreaterThan(0)
        expect(turn.modelId).toBe(AGENT_MODEL_ID)
      }
      // The same usage from a second persisted source: the credit ledger
      // wrote one row per finalize, and the two agree.
      const credit = await readCreditUsage(record.fixture)
      expect(credit.rows).toBe(turns.length)
      expect(credit.inputTokens).toBe(turns.reduce((n, t) => n + t.inputTokens, 0))
      expect(credit.outputTokens).toBe(turns.reduce((n, t) => n + t.outputTokens, 0))
      tokenTable.push({
        scenario: record.scenario,
        turns: turns.map((t) => ({
          agent: agentNameIn(record.fixture, t.agentId),
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          cachedInputTokens: t.cachedInputTokens,
        })),
        total: totalTokens(turns),
      })
    }
    // The anti blow up check: no scenario costs more than the measured cap.
    const worst = Math.max(...tokenTable.map((s) => s.total))
    console.log(
      `[p3b-tokens] scenario totals ${JSON.stringify(tokenTable.map((s) => [s.scenario, s.total]))}`,
    )
    console.log(`[p3b-tokens] worst scenario total ${worst} against cap ${K_SCENARIO_TOTAL_TOKENS}`)
    expect(worst).toBeLessThan(K_SCENARIO_TOTAL_TOKENS)
  }, 600_000)

  it("the ask overhead ratio is under the measured gate", async () => {
    // The control: the same question, asked of the finance agent directly,
    // with no coordination at all. Its turn is what one answer costs, and it is
    // the DIVISOR: the absolute overhead is dominated by the weak model's own
    // step size (one extra full context step is about 22,000 tokens whatever
    // the coordination did), so the comparable number is the ratio.
    const control = await fixture({ label: "control", financePrompt: financeLedgerPrompt() })
    await humanSays(
      control,
      `${mention(control.finance)} what is the total on invoice ${INVOICE_REFERENCE}?`,
    )
    controlTurnTokens = totalTokens(await readTurnUsage(control))
    expect(controlTurnTokens).toBeGreaterThan(0)

    const scenarioOne = answers.find((a) => a.scenario === "scenario 1")
    expect(scenarioOne).toBeDefined()
    const oneTurns = await readTurnUsage((scenarioOne as AnswerRecord).fixture)
    const oneTotal = totalTokens(oneTurns)
    const calleeOwn = totalTokens(
      oneTurns.filter((t) => t.agentId === (scenarioOne as AnswerRecord).fixture.finance.id),
    )
    askOverhead = oneTotal - calleeOwn - controlTurnTokens
    askOverheadRatioPercent = Math.round((askOverhead / controlTurnTokens) * 10000) / 100
    console.log(
      `[p3b-tokens] overhead ${askOverhead} = scenario1 ${oneTotal} - callee ${calleeOwn} - control ${controlTurnTokens}; ratio ${askOverheadRatioPercent} percent, gate ${K_ASK_OVERHEAD_RATIO_PERCENT}`,
    )
    expect(askOverheadRatioPercent).toBeLessThan(K_ASK_OVERHEAD_RATIO_PERCENT)
  }, 600_000)

  it("the overhead gate constant records three measurements and a date", async () => {
    const source = await Bun.file(`${import.meta.dir}/harness.ts`).text()
    for (const name of ["K_ASK_OVERHEAD_RATIO_PERCENT", "K_SCENARIO_TOTAL_TOKENS"]) {
      const at = source.indexOf(`export const ${name}`)
      expect(at).toBeGreaterThan(0)
      // The doc comment of THIS constant: from its own opening, never from a
      // window wide enough to catch the constant above it.
      const before = source.slice(0, at)
      const comment = before.slice(before.lastIndexOf("/**"))
      // Decimals allowed: the overhead gate is a PERCENTAGE of a control turn,
      // which is the only form in which it is comparable across runs.
      const measured = comment.match(
        /three runs: (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?),\s*\*?\s*(-?\d+(?:\.\d+)?)/,
      )
      expect(measured).not.toBeNull()
      expect(comment).toMatch(/Measured \d{4}-\d{2}-\d{2}/)
      // A gate that is not the measured formula is a hand edit.
      const raw = (measured as RegExpMatchArray).slice(1, 4).map(Number)
      const mean = raw.reduce((a, b) => a + b, 0) / 3
      const sd = Math.sqrt(raw.reduce((a, b) => a + (b - mean) ** 2, 0) / 3)
      const gate = Math.max(mean + 3 * sd, mean * 1.5)
      const pinned = Number((source.slice(at).match(/= (-?\d+)/) as RegExpMatchArray)[1])
      expect(pinned).toBe(Math.ceil(gate))
    }
  })

  it("every scenario scores at least four with the judge", async () => {
    expect(answers.length).toBe(7)
    for (const record of answers) {
      const rubric = RUBRICS[record.scenario]
      expect(rubric).toBeDefined()
      const verdict = await judgeAnswer({ rubric, answer: record.answer })
      judged.push({ scenario: record.scenario, ...verdict })
      console.log(
        `[p3b-judge] ${record.scenario}: ${verdict.score} of 5. ${verdict.sentence} ANSWER: ${record.answer.replace(/\s+/g, " ").slice(0, 300)}`,
      )
      expect(verdict.score).toBeGreaterThanOrEqual(4)
    }
  }, 600_000)

  it("the judge sees no expected value", () => {
    expect(judged.length).toBe(7)
    for (const [scenario, rubric] of Object.entries(RUBRICS)) {
      // The rubric carries the QUESTION, never the answer key: no seeded
      // figure, no seeded reference, no assertion text.
      expect(rubric).not.toContain(INVOICE_TOTAL)
      expect(rubric).not.toContain(INVOICE_REFERENCE)
      expect(rubric.toLowerCase()).not.toContain("expect")
      expect(rubric).not.toContain("parentMessageId")
      expect(rubric).not.toContain("hop_bound")
      expect(scenario).toBeTruthy()
    }
    // And the prompt is the rubric plus the answer, and nothing else.
    for (const verdict of judged) {
      const record = answers.find((a) => a.scenario === verdict.scenario) as AnswerRecord
      expect(verdict.prompt).toContain(RUBRICS[verdict.scenario])
      expect(verdict.prompt).toContain(record.answer)
      expect(verdict.prompt).not.toContain("toBe")
      expect(verdict.prompt).not.toContain("authorAgentId")
    }
  })

  it("the report file is written with both model ids in its header", async () => {
    const judge = judgeModelChoice()
    expect(judge).not.toBeNull()
    // The judge that actually scored, which is not always the preferred one.
    const judgeId = judgeModelUsed || (judge as { modelId: string }).modelId
    const judgePath = judgePathUsed || "provider"
    const worst = Math.max(...tokenTable.map((s) => s.total))
    const dir = await writeRunReport({
      date: RUN_DATE,
      agentModelId: AGENT_MODEL_ID,
      judgeModelId: judgeId,
      judgePath,
      judgeFallbackReason,
      askOverhead,
      controlTurnTokens,
      askOverheadRatioPercent,
      askOverheadRatioGatePercent: K_ASK_OVERHEAD_RATIO_PERCENT,
      worstScenarioTotal: worst,
      scenarioTotalGate: K_SCENARIO_TOTAL_TOKENS,
      loopCutReason,
      thirdLinkReason: `${thirdLinkReason} (guard: ${guardVerdictReason})`,
      scenarios: tokenTable.map((s) => {
        const verdict = judged.find((j) => j.scenario === s.scenario)
        return {
          scenario: s.scenario,
          verdict: verdictOf(s.scenario),
          judgeScore: verdict?.score ?? 0,
          judgeSentence: verdict?.sentence ?? "",
          turns: s.turns,
          total: s.total,
        }
      }),
    })
    const text = await Bun.file(`${dir}/report.md`).text()
    expect(text).toContain(AGENT_MODEL_ID)
    expect(text).toContain(judgeId)
    // The header states the path too: a run scored by the provider fallback
    // must never read like a run scored under the Claude Code login.
    expect(text).toContain(`(path: ${judgePath})`)
    for (const record of answers) expect(text).toContain(record.scenario)
    expect(await Bun.file(`${dir}/raw.json`).exists()).toBe(true)
  })

  it("a run with no login and no judge key reports not run rather than passed", async () => {
    const anthropic = process.env.LIAISON_ANTHROPIC_API_KEY
    const google = process.env.GOOGLE_API_KEY
    process.env.LIAISON_ANTHROPIC_API_KEY = ""
    process.env.GOOGLE_API_KEY = ""
    // The login path needs no key at all, so losing every key is only half of
    // "no judge": the SDK call is made to refuse here as a logged out machine
    // would refuse it.
    setSdkJudgeCall(async () => {
      throw new Error("Not logged in, please run /login")
    })
    try {
      expect(judgeModelChoice()).toBeNull()
      await expect(judgeAnswer({ rubric: "unused", answer: "unused" })).rejects.toThrow(/NOT RUN/)
    } finally {
      resetSdkJudgeCall()
      if (anthropic) process.env.LIAISON_ANTHROPIC_API_KEY = anthropic
      if (google) process.env.GOOGLE_API_KEY = google
    }
  })
})

/** The day this run is filed under, and the gestalt run directory it writes. */
const RUN_DATE = "2026-09-13"

/**
 * What the judge is told to look for, per scenario. The QUESTION only: no
 * seeded figure, no seeded reference, no assertion text. A judge shown the
 * expected value scores its own recall rather than the system's answer.
 */
const RUBRICS: Record<string, string> = {
  // Provenance is NOT in this rubric: where the figure came from is proven by
  // the persisted rows (a nested answer authored by the finance agent), and a
  // weak model drops the attribution sentence often enough that scoring prose
  // for it would score the model's obedience rather than the system. That gap
  // is a recorded finding, not a hidden pass.
  "scenario 1":
    "A person asked their personal assistant for the total amount on one of their invoices. Score the assistant's reply. Give 5 when the reply states one specific total clearly and answers the question asked, 2 when it is vague about the amount, and 0 when it states no total at all.",
  // What A14 forbids is a MACHINE name reaching a person: an identifier with
  // underscores, a permission string with colons. Saying in plain words that
  // it has no access is not a disclosure, so the rubric does not punish it.
  "scenario 2":
    "A person asked their personal assistant for the total amount on one of their invoices, and the assistant was not able to obtain it. Score the assistant's reply. Give 5 when it says clearly that it cannot provide the amount and states no amount; give 0 when it states an amount anyway; give 2 when it quotes a machine name, meaning an identifier written with underscores or a permission string written with colons. Saying in ordinary words that it does not have access to something is correct and must not lose a point. A reply scores 5 only when it states no figure it was not given.",
  "scenario 3":
    "A person asked their personal assistant a question that the assistant tried to pass along to colleagues and could not get answered. Score the assistant's reply. Give 5 when it says plainly that the question could not be answered or was not passed on any further, 0 when it invents an answer instead. A reply scores 5 only when it states no figure it was not given.",
  "scenario 4":
    "A person asked their personal assistant a question that it could not get answered by a colleague. Score the assistant's reply. Give 5 when it says plainly and once that it could not obtain an answer, 2 when it repeats itself or rambles, 0 when it invents an answer.",
  "scenario 5":
    "A person asked their personal assistant to bring a colleague agent into the conversation for the coming week. Score the assistant's reply. Give 5 when it confirms that the colleague is now in the conversation and answers nothing that was not asked, 0 when it does not say whether the colleague was brought in.",
  "scenario 6":
    "A person asked a logistics assistant whether a pallet for one of their orders has been delivered. Score the reply. Give 5 when it addresses the person and answers in one or two sentences, 0 when it does not answer at all.",
  // The reply judged here is the colleague agent's own answer to a colleague,
  // not an assistant's answer to a person: the scenario has no human facing
  // turn at all. The criterion is the same as scenario 1's.
  "scenario 7":
    "One assistant asked a colleague assistant for the total amount on an invoice. Score the colleague's answer. Give 5 when it states one specific total clearly and answers the question asked, 2 when it is vague about the amount, and 0 when it states no total at all.",
}

/**
 * What each scenario's STRUCTURE assertions did, as they did it.
 *
 * The report used to write the literal "PASS" beside every scenario, which is
 * a claim the report is in no position to make: a bun test that throws stops at
 * the throw, and a scenario that never reached its last line was still filed as
 * a pass. A scenario is marked FAIL the moment it starts and PASS only by its
 * own final statement, so a scenario that threw anywhere is reported as what it
 * was, and one that never ran at all reads NOT RUN.
 */
const scenarioVerdicts = new Map<string, string>()

function beginScenario(name: string): void {
  scenarioVerdicts.set(name, "FAIL")
}

function passScenario(name: string): void {
  scenarioVerdicts.set(name, "PASS")
}

function verdictOf(name: string): string {
  return scenarioVerdicts.get(name) ?? "NOT RUN"
}

export { verdictOf }

const judged: Array<{ scenario: string; score: number; sentence: string; prompt: string }> = []

export { judged }

/** Per scenario, per turn tokens, for the report. */
export interface ScenarioTokens {
  scenario: string
  turns: Array<{
    agent: string
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
  }>
  total: number
}
const tokenTable: ScenarioTokens[] = []
let askOverhead = 0
/** What one direct answer turn cost in this run: the ratio's divisor. */
let controlTurnTokens = 0
/** The overhead as a percentage of that control turn. The gated number. */
let askOverheadRatioPercent = 0

export { askOverhead, askOverheadRatioPercent, controlTurnTokens, tokenTable }

function agentNameIn(f: Fixture, agentId: string | null): string {
  if (agentId === f.alex.id) return f.alex.handle
  if (agentId === f.finance.id) return f.finance.handle
  if (agentId === f.logistics.id) return f.logistics.handle
  return "unknown"
}

/** The invite fixture, shared by scenarios 5 and 6 (6 continues 5's room). */
let inviteFixture: Fixture
/** Which guard cut the loop in scenario 4, for the report. */
let loopCutReason = "not asked"
/** Which guard refused the third link in scenario 3, for the report. */
let thirdLinkReason = "not asked"
/** What the guard said about the third link, for the report. */
let guardVerdictReason = "unknown"

export { guardVerdictReason, loopCutReason, thirdLinkReason }

/** What each scenario's human facing answer was, for the judge and the report. */
export interface AnswerRecord {
  scenario: string
  orgId: string
  answer: string
  fixture: Fixture
}
const answers: AnswerRecord[] = []
function recordAnswer(scenario: string, f: Fixture, row: MessageRow | undefined): void {
  answers.push({ scenario, orgId: f.orgId, answer: row?.content ?? "", fixture: f })
}

export { answers }
