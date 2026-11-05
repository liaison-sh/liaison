// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How long each agent step took, for the `agent_step_usage` line and the host
// speed samples (providers/openrouter-host-speed.ts). Fed by the AI SDK's
// model-call callbacks: the call starts, its first streamed chunk arrives (the
// time to first token), the call ends. `stepMs` is the whole step as a person
// waits for it: from the end of the previous step (or the turn's start) to this
// step's end, so it includes the previous step's tool runs.

export interface StepTimes {
  /** Request sent → first streamed chunk; null when no chunk was seen. */
  ttftMs: number | null
  /** Request sent → model call ended. */
  modelMs: number | null
  /** Previous step's end (or the turn's start) → this step's end. */
  stepMs: number
}

export class StepTimer {
  private callStartedAt: number | null = null
  private firstChunkAt: number | null = null
  private callEndedAt: number | null = null
  private lastStepEndedAt: number

  constructor(private readonly now: () => number = () => performance.now()) {
    this.lastStepEndedAt = now()
  }

  callStart(): void {
    this.callStartedAt = this.now()
    this.firstChunkAt = null
    this.callEndedAt = null
  }

  chunk(): void {
    if (this.callStartedAt !== null && this.firstChunkAt === null) this.firstChunkAt = this.now()
  }

  callEnd(): void {
    if (this.callStartedAt !== null) this.callEndedAt = this.now()
  }

  /** This step's times; the next step's `stepMs` counts from here. */
  stepFinished(): StepTimes {
    const t = this.now()
    const start = this.callStartedAt
    const times: StepTimes = {
      ttftMs:
        start !== null && this.firstChunkAt !== null ? Math.round(this.firstChunkAt - start) : null,
      modelMs: start !== null ? Math.round((this.callEndedAt ?? t) - start) : null,
      stepMs: Math.round(t - this.lastStepEndedAt),
    }
    this.lastStepEndedAt = t
    this.callStartedAt = null
    this.firstChunkAt = null
    this.callEndedAt = null
    return times
  }
}
