// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How a failed host bridge call reaches the QuickJS handler, shared by the
// in-process executor (trusted apps) and the worker subprocess (untrusted).
//
// A statusless host error stays the plain string handlers have always caught.
// A typed refusal (a kernel service 404 such as a task key that does not
// exist) becomes an Error carrying its HTTP `status` and `code`, so a handler
// that lets it propagate reaches execute-tool as that 4xx: logged at warn and
// returned to the agent as `not_found`, instead of a statusless fault that
// pages the watchdog.

import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten"

export interface TypedBridgeFailure {
  status: number
  code?: string
}

/** The HTTP class and code of a host error, when it carries one. */
export function typedBridgeFailure(err: unknown): TypedBridgeFailure | undefined {
  const e = err as { status?: unknown; code?: unknown } | null | undefined
  const status = e?.status
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status >= 600) {
    return undefined
  }
  return typeof e?.code === "string" ? { status, code: e.code } : { status }
}

/** The QuickJS value a bridge promise rejects with. The caller disposes it. */
export function newBridgeRejection(
  ctx: QuickJSContext,
  message: string,
  typed: TypedBridgeFailure | undefined,
): QuickJSHandle {
  if (!typed) return ctx.newString(message)
  const errHandle = ctx.newError(message)
  const statusHandle = ctx.newNumber(typed.status)
  ctx.setProp(errHandle, "status", statusHandle)
  statusHandle.dispose()
  if (typed.code !== undefined) {
    const codeHandle = ctx.newString(typed.code)
    ctx.setProp(errHandle, "code", codeHandle)
    codeHandle.dispose()
  }
  return errHandle
}

/** Carry a rethrown typed refusal's status and code from a QuickJS dump onto the host Error. */
export function applyTypedFailure(err: Error, errVal: unknown): Error {
  const typed = errVal && typeof errVal === "object" ? typedBridgeFailure(errVal) : undefined
  if (!typed) return err
  ;(err as { status?: number }).status = typed.status
  if (typed.code !== undefined && (err as { code?: unknown }).code === undefined) {
    ;(err as { code?: string }).code = typed.code
  }
  return err
}
