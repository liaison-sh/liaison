// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

/** The only field an ownership transfer carries: the agent taking the work. */
export const reassignOwnerSchema = z.object({ ownerAgentId: z.string().uuid() })
