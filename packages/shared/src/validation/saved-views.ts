// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

export const savedViewPayloadSchema = z.record(z.string(), z.unknown())

export const createSavedViewSchema = z.object({
  app: z.string().min(1).max(50),
  viewId: z.string().min(1).max(50),
  name: z.string().min(1).max(120),
  payload: savedViewPayloadSchema,
  sharedWithOrg: z.boolean().optional(),
})
export type CreateSavedView = z.infer<typeof createSavedViewSchema>

export const updateSavedViewSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  payload: savedViewPayloadSchema.optional(),
  sharedWithOrg: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
})
export type UpdateSavedView = z.infer<typeof updateSavedViewSchema>

export const savedViewOwnerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.enum(["active", "suspended", "deactivated"]),
})

export const savedViewSchema = z.object({
  id: z.string().uuid(),
  app: z.string(),
  viewId: z.string(),
  manifestKey: z.string().nullable(),
  name: z.string(),
  payload: savedViewPayloadSchema,
  ownerUserId: z.string().uuid().nullable(),
  owner: savedViewOwnerSchema.nullable(),
  sharedWithOrg: z.boolean(),
  isDefault: z.boolean(),
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SavedView = z.infer<typeof savedViewSchema>
