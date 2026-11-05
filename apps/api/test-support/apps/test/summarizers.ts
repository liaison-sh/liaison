// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApprovalSummary } from "@liaison/shared"
import type { RlsClient } from "~/db"

export async function summarizeGatedEcho(
  params: { message: string; lines?: string[] },
  _ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  return {
    kind: "test.gated_echo",
    title: `Echo: ${params.message}`,
    // `lines`: a card test's own summary lines, rendered as a real summarizer's.
    lines: params.lines && params.lines.length > 0 ? params.lines : [`Message: ${params.message}`],
  }
}

export async function summarizeGatedProduce(
  params: { seed: string },
  _ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  return {
    kind: "test.gated_produce",
    title: `Produce value from "${params.seed}"`,
    lines: [`Seed: ${params.seed}`],
  }
}

export async function summarizeGatedConsume(
  params: { note: string; label: string },
  _ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  return {
    kind: "test.gated_consume",
    title: "Consume produced value",
    lines: [`Note: ${params.note}`, `Label: ${params.label}`],
  }
}
