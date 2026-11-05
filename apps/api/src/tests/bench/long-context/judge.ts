// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The judge. The ladder is `JUDGE_SDK_MODELS` from the coordination e2e judge,
// run through this Mac's Claude Code login, and nothing here ever reads an
// Anthropic API key. When every model on the ladder refuses, the judge falls
// back to Gemini pro on GOOGLE_API_KEY, and the report header names whichever
// one actually scored.
import { createGoogle } from "@ai-sdk/google"
import { generateText } from "ai"
import { JUDGE_SDK_MODELS } from "../../e2e/agent-coordination/sdk-judge"
import { callAgentSdk } from "./answerers"
import type { ProbeKind } from "./types"

export const FALLBACK_JUDGE_MODEL = "gemini-pro-latest"

export const RUBRIC = [
  "You are grading one answer from an assistant that was resumed cold on a long conversation.",
  "Score it against the ground truth answer:",
  "2 = correct AND current at this point of the conversation.",
  "1 = partially correct, or stale (it gives a value that was superseded by this point).",
  "0 = wrong, or invented (it states something the conversation does not support).",
  'For a distractor probe (ground truth "never came up"), 2 only when the answer says it never came up; anything asserted about it is 0.',
  "Reply with the single digit and nothing else.",
].join("\n")

export interface JudgeRequest {
  question: string
  expected: string
  answer: string
  kind: ProbeKind
}

export interface Judge {
  /** The model that actually scored, for the report header. */
  modelId: string
  path: "sdk-login" | "provider" | "unavailable"
  fallbackReason: string
  score(req: JudgeRequest): Promise<number>
}

export function buildJudgePrompt(req: JudgeRequest): string {
  return [
    RUBRIC,
    "",
    `Probe kind: ${req.kind}`,
    `Question: ${req.question}`,
    `Ground truth: ${req.expected}`,
    "Answer to grade:",
    req.answer || "(the assistant returned nothing)",
  ].join("\n")
}

/** The first 0, 1 or 2 in the judge's reply. Anything else is a failed grade. */
export function parseScore(text: string): number | null {
  const match = /[012]/.exec(text.trim())
  if (!match) return null
  return Number(match[0])
}

export async function createJudge(params: {
  geminiApiKey: string | null
  sdkModels?: readonly string[]
}): Promise<Judge> {
  const refusals: string[] = []
  for (const model of params.sdkModels ?? JUDGE_SDK_MODELS) {
    try {
      const probe = await callAgentSdk(model, "Reply with the single character 2 and nothing else.")
      if (parseScore(probe.text) === null) throw new Error("no digit in the warm up reply")
      return {
        modelId: model,
        path: "sdk-login",
        fallbackReason: "",
        async score(req) {
          const out = await callAgentSdk(model, buildJudgePrompt(req))
          const score = parseScore(out.text)
          if (score === null)
            throw new Error(`the judge returned no digit: ${out.text.slice(0, 120)}`)
          return score
        },
      }
    } catch (err) {
      refusals.push(`${model}: ${String(err).slice(0, 160)}`)
    }
  }
  const reason = `the Claude Code login judge could not run (${refusals.join("; ")})`
  if (!params.geminiApiKey) {
    return {
      modelId: "none",
      path: "unavailable",
      fallbackReason: `${reason} and no GOOGLE_API_KEY for the fallback judge`,
      async score() {
        throw new Error("no judge is available: this run is NOT RUN, never passed")
      },
    }
  }
  const google = createGoogle({ apiKey: params.geminiApiKey })
  const model = google(FALLBACK_JUDGE_MODEL)
  return {
    modelId: FALLBACK_JUDGE_MODEL,
    path: "provider",
    fallbackReason: reason,
    async score(req) {
      const out = await generateText({
        model: model as any,
        prompt: buildJudgePrompt(req),
      })
      const score = parseScore(out.text)
      if (score === null) throw new Error(`the judge returned no digit: ${out.text.slice(0, 120)}`)
      return score
    },
  }
}
