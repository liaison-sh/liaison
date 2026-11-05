// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Recorded node sessions survive a restart: on the leader's boot, every replay
// still running continues from the last event it appended (replay.ts reads
// its cursor from the session's event log, so nothing is appended twice).
//
// Only on a demo instance. The resume runs shortly after this process takes
// the leader lease (a singleton hook), and only while it leads; each session's
// Redis lock keeps a second process from ever playing the same replay.
import { isLeader, registerSingleton } from "~/infra/leadership"
import { rootLogger } from "~/lib/logger"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { resumeRunningReplays } from "./replay"

const log = rootLogger.child({ module: "demo-replay-resume" })

/** How long after boot the resume runs. */
export const REPLAY_RESUME_DELAY_MS = 10_000

/** Resume every running replay now, on the leader. Returns how many it launched. Never throws. */
export async function resumeReplaysOnLeader(): Promise<number> {
  if (!isDemoModeEnabled() || !isLeader()) return 0
  try {
    const n = await resumeRunningReplays()
    if (n > 0) log.info({ replays: n }, "demo replays resumed")
    return n
  } catch (err) {
    log.error({ err }, "resuming demo replays failed")
    return 0
  }
}

let armed: ReturnType<typeof setTimeout> | null = null

function disarm(): void {
  if (armed) clearTimeout(armed)
  armed = null
}

/**
 * Make the resume the `demo-replay-resume` singleton: taking the leader lease
 * arms a resume `delayMs` later, losing it disarms a pending one. Called once
 * at boot; does nothing outside a demo instance.
 */
export function registerReplayResumeSingleton(delayMs: number = REPLAY_RESUME_DELAY_MS): void {
  if (!isDemoModeEnabled()) return
  registerSingleton({
    name: "demo-replay-resume",
    onAcquired: () => {
      disarm()
      armed = setTimeout(() => {
        armed = null
        void resumeReplaysOnLeader()
      }, delayMs)
      ;(armed as { unref?: () => void }).unref?.()
    },
    onLost: disarm,
  })
}

/** Test seam: whether a resume is armed. */
export const ReplayResumeTestAccess = {
  armed(): boolean {
    return armed !== null
  },
}
