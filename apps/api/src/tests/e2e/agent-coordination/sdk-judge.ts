// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-FX5: the judge, run under this machine's own Claude Code login.
//
// The provider layer judge needs a funded org key, and the org's Anthropic key
// has none: every run so far fell back to the Google judge and said so in its
// header. The Claude Agent SDK spawns the Claude Code CLI that is already
// logged in on this Mac, so the strong judge needs no key at all (the desktop
// sidecar runs the same shape).
//
// This module owns two things and nothing else: how one SDK grading call is
// made, and which judge a run ends up with. The provider judge stays as the
// fallback, and the run always states which one scored.

/**
 * The ladder the login is asked for, strongest first. A model the login
 * refuses is a thrown error, so the next one is tried; sonnet is reached only
 * when both opus models are refused.
 */
export const JUDGE_SDK_MODELS = ["claude-opus-4-6", "claude-opus-5", "claude-sonnet-5"] as const

/** Which of the two judges scored a run. Reported in the run's header. */
export type JudgePath = "sdk-login" | "provider"

/** One grading call. Resolves with the answer text, throws when it cannot run. */
export type SdkJudgeCall = (model: string, prompt: string) => Promise<string>

/** What the provider layer judge answered, and why it was not the preferred one. */
export interface ProviderJudgeResult {
  modelId: string
  text: string
  reason?: string
}

export interface JudgeRun {
  path: JudgePath
  modelId: string
  text: string
  /** Empty when the preferred judge ran; every refusal on the way otherwise. */
  fallbackReason: string
}

/**
 * One grading call through the Claude Agent SDK, which spawns the logged in
 * Claude Code CLI. No MCP servers, no tools, none of this machine's settings:
 * the judge sees one prompt and answers it, exactly as the spike's shape.
 */
export async function callAgentSdkJudge(model: string, prompt: string): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk")
  const session = query({
    prompt,
    options: {
      model,
      settingSources: [],
      mcpServers: {},
      allowedTools: [],
      maxTurns: 1,
    },
  })
  let text = ""
  for await (const message of session) {
    if (message.type !== "result") continue
    if (message.subtype !== "success") {
      throw new Error(`the ${model} judge ended ${message.subtype}`)
    }
    text = message.result
  }
  if (!text) throw new Error(`the ${model} judge returned no result message`)
  return text
}

/**
 * The judge this run gets: the login ladder first, the provider layer only
 * when every model on it refused. With neither, the run is NOT RUN rather than
 * quietly passed.
 */
export async function runJudge(params: {
  prompt: string
  sdk: SdkJudgeCall
  provider: (() => Promise<ProviderJudgeResult>) | null
  sdkModels?: readonly string[]
}): Promise<JudgeRun> {
  const refusals: string[] = []
  for (const model of params.sdkModels ?? JUDGE_SDK_MODELS) {
    try {
      const text = await params.sdk(model, params.prompt)
      return { path: "sdk-login", modelId: model, text, fallbackReason: "" }
    } catch (err) {
      refusals.push(`${model}: ${String(err).slice(0, 160)}`)
    }
  }
  const reason = `the Claude Code login judge could not run (${refusals.join("; ")})`
  if (!params.provider) {
    throw new Error(`${reason} and no provider judge key is set: this run is NOT RUN, never passed`)
  }
  const out = await params.provider()
  return {
    path: "provider",
    modelId: out.modelId,
    text: out.text,
    fallbackReason: [reason, out.reason].filter(Boolean).join("; "),
  }
}
