// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

export const bulkDispatchRequestSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Duplicate ids are not allowed",
    }),
  params: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().uuid(),
})
export type BulkDispatchRequest = z.infer<typeof bulkDispatchRequestSchema>

export const bulkErrorSchema = z.object({
  id: z.string(),
  code: z.string(),
  message: z.string(),
})
export type BulkError = z.infer<typeof bulkErrorSchema>

export const bulkItemSchema = z.object({
  id: z.string(),
  status: z.enum(["succeeded", "failed", "pending_approval"]),
  approvalRequestId: z.string().uuid().optional(),
  error: z.string().optional(),
})
export type BulkItem = z.infer<typeof bulkItemSchema>

export const bulkDispatchResponseSchema = z.object({
  bulkRequestId: z.string().uuid(),
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  approvalsCreated: z.number().int().nonnegative(),
  errors: z.array(bulkErrorSchema),
  items: z.array(bulkItemSchema),
})
export type BulkDispatchResponse = z.infer<typeof bulkDispatchResponseSchema>
