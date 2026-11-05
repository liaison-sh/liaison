// SPDX-License-Identifier: FSL-1.1-ALv2
// A tool run through `POST /apps/run-tool` answers "nothing is connected" with
// a 200 whose data is `{ error: { code: "not_connected" | "<x>_not_connected",
// message } }` (the server's isNotConnectedToolErrorCode): a fresh install is a
// normal state, not a fault. A caller that only looks for a thrown error reads
// that answer as success, so status probes check the body with this.

export interface ToolErrorAnswer {
  code: string
  message: string
}

/** The `{ error }` envelope a tool returned as its answer, or null. */
export function toolErrorAnswer(result: unknown): ToolErrorAnswer | null {
  if (typeof result !== "object" || result === null || !("error" in result)) return null
  const error = (result as { error?: unknown }).error
  if (typeof error !== "object" || error === null) return null
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (typeof code !== "string") return null
  return { code, message: typeof message === "string" ? message : code }
}

export function isNotConnectedCode(code: string | undefined): boolean {
  return code === "not_connected" || (code?.endsWith("_not_connected") ?? false)
}
