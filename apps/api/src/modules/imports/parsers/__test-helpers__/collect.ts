// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ParsedRecord } from "../common"

export async function collect(it: AsyncIterable<ParsedRecord>): Promise<ParsedRecord[]> {
  const out: ParsedRecord[] = []
  for await (const r of it) out.push(r)
  return out
}

export async function failure(it: AsyncIterable<ParsedRecord>): Promise<Error> {
  try {
    for await (const _ of it) {
      // drain
    }
  } catch (err) {
    if (err instanceof Error) return err
    throw err
  }
  throw new Error("expected the parser to fail")
}
