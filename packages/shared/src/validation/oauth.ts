// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

export const createProviderSchema = z.object({
  name: z.string().min(1),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.string().optional(),
  autoProvision: z.boolean().optional(),
})
