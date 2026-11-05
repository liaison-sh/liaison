// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

export const idParam = z.object({ id: z.string().uuid() })
export const threadIdParam = z.object({ threadId: z.string().uuid() })
export const threadMessageParam = z.object({
  threadId: z.string().uuid(),
  messageId: z.string().uuid(),
})
export const threadUserParam = z.object({ threadId: z.string().uuid(), userId: z.string().uuid() })
