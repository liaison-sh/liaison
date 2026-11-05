// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * Read `body` into one Buffer, refusing as soon as it passes `capBytes`
 * (a body of exactly `capBytes` is kept). Over the cap the stream is
 * cancelled (a failed cancel is ignored: the cap holds either way) and the
 * result is null, so nothing past the cap is ever buffered, whatever the
 * content-length says. Callers keep their own policy around it: the
 * content-length precheck, what a missing body means, how the bytes are
 * decoded, and the error an oversized body raises.
 */
export async function readStreamCapped(
  body: ReadableStream<Uint8Array>,
  capBytes: number,
): Promise<Buffer | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > capBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}
