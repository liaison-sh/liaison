// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AppContext } from "./types"

export function defineHandlers<
  T extends Record<string, (params: any, ctx: AppContext) => Promise<any>>,
>(handlers: T): T {
  return handlers
}
