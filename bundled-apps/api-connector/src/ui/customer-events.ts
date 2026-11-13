// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which entity events refresh the customer card.

import type { HostEntityChangeEvent as EntityChangeEvent } from "@liaison/host"

/** The gated tool an API connection's writes run through. */
const CONNECTOR_WRITE_TOOL = "api-connector:connector_write"

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

/**
 * Did this event report a connector write, approved and run, that can change
 * what the card shows for `email`? A write that names another person's email
 * cannot; one that names none (a note on a company) may, so it counts.
 */
export function isConnectorWriteFor(ev: EntityChangeEvent, email: string): boolean {
  if (ev.key !== "kernel:approval_request" || ev.action !== "update") return false
  const data = record(ev.data)
  if (data?.status !== "approved" || data.toolName !== CONNECTOR_WRITE_TOOL) return false
  const params = record(record(data.currentPayload)?.params)
  const written = params?.email
  return typeof written !== "string" || written.trim().toLowerCase() === email.toLowerCase()
}
