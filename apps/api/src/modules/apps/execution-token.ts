// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The identity of ONE tool execution.
 *
 * The sandbox pool bounds a handler's cross-app fan-out per PARENT EXECUTION
 * (`nestedParentKey`). Keyed on anything an execution shares with another one
 * (the chain of tool names, say) two concurrent, independent executions of the
 * same chain collapse into a single budget and the second one's first hop is
 * demoted behind the first one's, with no caller in common between them. So the
 * key has to be minted fresh per execution, and that mint is what this module
 * owns.
 *
 * It also carries the observation seam for the mint. The token never leaves the
 * bridge closure it is threaded into, so without a seam the only thing holding
 * "one token per execution" is the shape of the code: replacing the mint with a
 * single constant kept every test green. Nothing arms the observer in
 * production (`armExecutionTokenObserver` refuses outright when NODE_ENV is
 * production) and no production path reads it.
 */

type ExecutionTokenObserver = (token: string) => void

/**
 * Everything watching the mint right now. A single slot made arming
 * destructive: a second armer overwrote the first, and the disarm it handed
 * back nulled the slot whoever owned it, so two watchers in one process
 * silently disabled each other depending on which ran first.
 */
const observers = new Set<ExecutionTokenObserver>()

/** A fresh identity for one tool execution. */
export function mintExecutionToken(): string {
  const token = crypto.randomUUID()
  for (const observe of [...observers]) observe(token)
  return token
}

/**
 * Watch every token minted from here. Returns a disarm that takes down THIS
 * armer and nothing else, so a test can release it in a `finally` without
 * standing on whatever armed before it. Idempotent.
 */
export function armExecutionTokenObserver(fn: ExecutionTokenObserver): () => void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The execution token observer cannot be armed in production")
  }
  observers.add(fn)
  let disarmed = false
  return () => {
    if (disarmed) return
    disarmed = true
    observers.delete(fn)
  }
}

/** Stop watching, every armer at once. A reset, not a disarm. Idempotent. */
export function clearExecutionTokenObserver(): void {
  observers.clear()
}
