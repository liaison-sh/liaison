// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  LOCAL_TURN_MAX_BYTES,
  LOCAL_TURN_MAX_TOOL_CALLS,
  LOCAL_TURN_TIMELINE_TEXT_LIMIT,
  normalizeLocalToolName,
  REDACTED,
  redactArgs,
  redactSecrets,
  sanitizeLocalTurnRecord,
} from "./local-turn"

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl"

describe("redactSecrets", () => {
  it("strikes a bearer, a JWT, a query token and a known key prefix", () => {
    const line = `curl -H "Authorization: Bearer ${JWT}" "https://x.example/a?token=abc123&v=2" sk-ant-api03-ABCDEFGHIJKLMNOP`
    const out = redactSecrets(line)
    expect(out).not.toContain(JWT)
    expect(out).not.toContain("abc123")
    expect(out).not.toContain("sk-ant-api03")
    expect(out).toContain("v=2")
  })

  it("strikes a secret in a JSON body and a signed URL", () => {
    const out = redactSecrets(
      `{"access_token":"t0k3n","name":"hub"} https://s3.example/f?X-Amz-Signature=deadbeef&X-Amz-Date=1`,
    )
    expect(out).toContain(`"access_token":"${REDACTED}"`)
    expect(out).toContain('"name":"hub"')
    expect(out).not.toContain("deadbeef")
  })

  it("strikes a long opaque token and leaves a hex digest, a path and prose alone", () => {
    const token = "Zx8Kq2Lm9Pw4Rt7Yb3Nc6Vd1Hf5Gj0Ss"
    const digest = "a".repeat(40)
    const out = redactSecrets(
      `cap ${token} sha ${digest} /Users/me/Rapports Liaison/2026.08 review.pdf Token expired`,
    )
    expect(out).not.toContain(token)
    expect(out).toContain(digest)
    expect(out).toContain("/Users/me/Rapports Liaison/2026.08 review.pdf")
    expect(out).toContain("Token expired")
  })

  it("W3-D5: a Claude Code project-folder slug is a folder name, kept; a token anywhere else, any path included, is still struck", () => {
    const slug = "-Volumes-Data-tmp-sam-liaison-walk-r2"
    const token = "Zx8Kq2Lm9Pw4Rt7Yb3Nc6Vd1Hf5Gj0Ss"
    const kept = [
      `<output-file>/Volumes/Data/tmp/claude-501/${slug}/790403d4/tasks/a1.output</output-file>`,
      `{"cwd":"/Users/me/.claude/projects/${slug}/s.jsonl"}`,
      `ls ~/.claude/projects/${slug}/`,
      `cd /home/me/.claude/projects/-home-me-${token}`,
    ]
    for (const text of kept) expect(redactSecrets(text)).toBe(text)
  })

  it("W3-D5 review: a token that is a whole segment of a local path, not a project slug, is struck", () => {
    const token = "Zx8Kq2Lm9Pw4Rt7Yb3Nc6Vd1Hf5Gj0Ss"
    const struck = [
      // A whole segment of a local path that is not a project slug.
      `file=/tmp/x/${token}/y`,
      `GET /private/${token}/download HTTP/1.1`,
      `cat ~/.config/svc/${token}/creds`,
      `/var/run/${token}/sock`,
      `"path":"/tmp/${token}/x"`,
      // Slug-shaped but in the wrong place, or a token behind a dash.
      `/tmp/x/-Users-${token}/y`,
      `ls ~/.claude/projects/-${token}/`,
      // Not a whole segment: the file name's run.
      `/Users/me/${token}.txt`,
      // A URL's path, with or without its scheme.
      `https://files.example/Users/${token}/x`,
      `GET /cap/${token}/download`,
      // A relative path.
      `src/${token}/x`,
      // A bare token.
      `cap ${token} end`,
    ]
    for (const text of struck) expect(redactSecrets(text)).not.toContain(token)
  })

  // The base's long-token rule, kept here as the reference only: it is
  // quadratic (every `\b` of "a-a-a-…" restarts three lookaheads over the run).
  const BASE_TOKEN_RULE =
    /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/g

  it("A59: the linear long-token rule strikes exactly what the base rule struck", () => {
    // Deterministic noise over the token alphabet plus separators, so runs
    // start and end on `-`, `_`, digits and both cases.
    const alphabet = "aZ9-_bY8-cX7_dW6eV5fU4 .gT3hS2-iR1jQ0kPl/Om-Nn_"
    let seed = 7
    for (let c = 0; c < 400; c++) {
      let s = ""
      const len = 20 + (c % 90)
      for (let i = 0; i < len; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        s += alphabet[seed % alphabet.length]
      }
      expect(redactSecrets(s)).toBe(s.replace(BASE_TOKEN_RULE, REDACTED))
    }
    for (const s of [
      `-${"aB3".repeat(11)}`,
      `${"aB3".repeat(11)}-`,
      `--${"x".repeat(31)}Y1--`,
      `a-${"Zz9".repeat(12)}`,
      `${"aB3".repeat(10)}-xy`,
    ]) {
      expect(redactSecrets(s)).toBe(s.replace(BASE_TOKEN_RULE, REDACTED))
    }
  })

  const fill = (unit: string, bytes: number) =>
    unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes)
  // CPU time, not wall time: a busy machine (every suite of a gate at once)
  // inflated a 50 ms pass to seconds of wall time. redactSecrets is synchronous
  // on this thread, so the process's CPU time is its own cost, and a quadratic
  // rule still burns minutes of it on 1 MiB.
  const cpuMs = (input: string) => {
    const start = process.cpuUsage()
    redactSecrets(input)
    const spent = process.cpuUsage(start)
    return (spent.user + spent.system) / 1000
  }
  // The fastest of five runs: a GC pause only ever adds time, so the minimum is
  // the call's own cost, and a quadratic rule is slow on every run.
  const fastestMs = (input: string) => {
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < 5; i++) best = Math.min(best, cpuMs(input))
    return best
  }
  for (const unit of [
    "\n",
    "\n ",
    "a=",
    "A",
    "-",
    "a-",
    ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""),
    '"k":"',
    "x://a:",
    "Bearer ",
    // W3-D5: the path-segment scan.
    `/Users/${"aB3".repeat(11)}`,
    `/${"aB3".repeat(11)}`,
    "/Users/a /",
    `/.claude/projects/-Users-${"aB3".repeat(11)}`,
    `/tmp/claude-${"a".repeat(60)}/-Users-${"aB3".repeat(11)}`,
  ]) {
    it(`A59: redactSecrets on 1 MiB of ${JSON.stringify(unit)} is under 500 ms and linear`, () => {
      // A 64 KiB pass first: a quadratic rule would spend minutes on 1 MiB, so
      // one over 125 ms (4x the linear share of 500 ms) fails before that.
      const early = cpuMs(fill(unit, 64 * 1024))
      if (early > 125) {
        expect({ unit, early: Math.round(early) }).toEqual({ unit, early: 0 })
        return
      }
      const big = fastestMs(fill(unit, 1024 * 1024))
      // The small time is floored at 1 ms: below it the ratio is timer noise.
      const ratio = big / Math.max(fastestMs(fill(unit, 256 * 1024)), 1)
      expect({ unit, ms: big < 500, linear: ratio < 8 }).toEqual({ unit, ms: true, linear: true })
    }, 30_000)
  }
})

describe("redactArgs", () => {
  it("strikes every key that names a secret, whatever its value looks like", () => {
    expect(redactArgs({ apiKey: "short", password: "x", query: "Havre" })).toEqual({
      apiKey: REDACTED,
      password: REDACTED,
      query: "Havre",
    })
  })
})

describe("sanitizeLocalTurnRecord", () => {
  it("keeps the cloud shape and drops what does not fit it", () => {
    const record = sanitizeLocalTurnRecord({
      modelId: "claude-haiku-4-5",
      toolCalls: [
        {
          toolCallId: "a",
          toolName: "mcp__liaison__kpi__kpi_run",
          args: { hub: 1 },
          status: "completed",
          result: "ok",
        },
        { toolCallId: "a", toolName: "dup" },
        { toolName: "no id" },
      ],
      timeline: [
        { kind: "tool", toolCallId: "a" },
        { kind: "tool", toolCallId: "ghost" },
        { kind: "reasoning", text: `think ${JWT}` },
        { kind: "script", text: "no" },
      ],
      usage: { inputTokens: 10, lastStepInputTokens: -4, outputTokens: "9" },
      finishReason: "DROP TABLE",
      requiredScopes: ["*"],
    })
    expect(record.toolCalls).toHaveLength(1)
    expect(record.toolCalls[0]?.toolName).toBe("kpi__kpi_run")
    expect(record.timeline).toEqual([
      { kind: "tool", toolCallId: "a" },
      { kind: "reasoning", text: `think ${REDACTED}` },
    ])
    expect(record.usage).toEqual({ inputTokens: 10 })
    expect(record.finishReason).toBe("stop")
    expect(JSON.stringify(record)).not.toContain("requiredScopes")
  })

  it("keeps the answer's words where they were written, as the reply stores them", () => {
    const record = sanitizeLocalTurnRecord({
      toolCalls: [{ toolCallId: "a", toolName: "Bash", args: {}, status: "completed" }],
      timeline: [
        { kind: "text", text: "Je lance le pipeline." },
        { kind: "tool", toolCallId: "a" },
        { kind: "text", text: "   " },
        { kind: "text", text: "Rapport prêt." },
      ],
    })
    expect(record.timeline).toEqual([
      { kind: "text", text: "Je lance le pipeline." },
      { kind: "tool", toolCallId: "a" },
      { kind: "text", text: "Rapport prêt." },
    ])
  })

  it("drops text entries whole past the reply's bound, never cuts one", () => {
    const big = "x".repeat(LOCAL_TURN_TIMELINE_TEXT_LIMIT - 10)
    const record = sanitizeLocalTurnRecord({
      timeline: [
        { kind: "text", text: big },
        { kind: "text", text: "y".repeat(20) },
      ],
    })
    expect(record.timeline).toEqual([{ kind: "text", text: big }])
  })

  it("is bounded however much the client sends", () => {
    const toolCalls = Array.from({ length: LOCAL_TURN_MAX_TOOL_CALLS + 50 }, (_, i) => ({
      toolCallId: `c${i}`,
      toolName: "Bash",
      args: { command: "x".repeat(10_000) },
    }))
    const record = sanitizeLocalTurnRecord({ toolCalls })
    expect(record.toolCalls).toHaveLength(LOCAL_TURN_MAX_TOOL_CALLS)
    const first = record.toolCalls[0]
    expect(first).toBeDefined()
    const args = (first as { args: { command: string } }).args
    expect(args.command.length).toBeLessThan(2_100)
  })

  it("keeps the whole record under the byte budget the reply route can take", () => {
    const toolCalls = Array.from({ length: LOCAL_TURN_MAX_TOOL_CALLS }, (_, i) => ({
      toolCallId: `c${i}`,
      toolName: "Bash",
      args: Object.fromEntries(Array.from({ length: 50 }, (_, k) => [`a${k}`, "y".repeat(5_000)])),
      result: "r".repeat(50_000),
      status: "completed",
    }))
    const record = sanitizeLocalTurnRecord({ toolCalls })
    expect(JSON.stringify(record).length).toBeLessThan(LOCAL_TURN_MAX_BYTES + 10_000)
    expect(record.toolCalls).toHaveLength(LOCAL_TURN_MAX_TOOL_CALLS)
    expect(record.toolCalls[0]?.toolName).toBe("Bash")
  })

  it("names a Liaison tool the way the server does", () => {
    expect(normalizeLocalToolName("mcp__liaison__kernel__threads_list")).toBe(
      "kernel__threads_list",
    )
    expect(normalizeLocalToolName("Bash")).toBe("Bash")
    expect(normalizeLocalToolName("mcp__other__thing")).toBe("mcp__other__thing")
  })
})
