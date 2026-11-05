// SPDX-License-Identifier: FSL-1.1-ALv2
export class RequestBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Payload too large (max ${maxBytes} bytes)`)
    this.name = "RequestBodyTooLargeError"
  }
}

export async function readRequestBytesWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes)
  }

  if (!request.body) return new Uint8Array(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel("payload_too_large")
      throw new RequestBodyTooLargeError(maxBytes)
    }

    chunks.push(value)
  }

  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

export async function readRequestTextWithLimit(
  request: Request,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readRequestBytesWithLimit(request, maxBytes))
}
