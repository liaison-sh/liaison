// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * `p`, or a rejection with `timeoutError()` once `ms` pass without an answer.
 * The timer never keeps the process alive and is cleared once `p` settles.
 */
export function boundedBy<T>(p: Promise<T>, ms: number, timeoutError: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), ms)
    timer.unref?.()
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}
