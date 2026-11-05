// SPDX-License-Identifier: FSL-1.1-ALv2
// Provider contracts: definitions shared by the kernel (registration, dispatch) and the apps
// that implement or call them.
export * from "./einvoicing-pa"

/** What `ctx.contracts.call(contract, op, params)` answers (always pass `params` as an object). */
export type ContractEnvelope<T = unknown> =
  | { status: "completed"; result: T; provider: string }
  | { status: "error"; error: { code: string; message: string; retryable?: boolean } }

/** `ctx.contracts` as the kernel exposes it to a sandboxed app declaring `contract_calls`. */
export interface ContractsAccessor {
  /**
   * `opts.grant`: the dispatch grant an outbound op needs (from `grant`); without it the kernel
   * refuses `contract_grant_required`.
   */
  call<T = unknown>(
    contract: string,
    op: string,
    params: Record<string, unknown>,
    opts?: { grant?: string | null },
  ): Promise<ContractEnvelope<T>>
  /**
   * Mint a dispatch grant for the outbound `ops`, binding `subject` (param name → value that each
   * call must carry). Only inside a person's approval of one of this app's gated `noAutoApprove`
   * tools, or that approver's own click; refused (`contract_grant_refused`) anywhere else.
   */
  grant(
    contract: string,
    ops: string[],
    subject: Record<string, string>,
  ): Promise<{ grant: string } | { status: "error"; error: { code: string; message: string } }>
  /** The provider the organisation's administrator bound for this app and contract (or null). */
  binding(contract: string): Promise<{ provider: string | null }>
  /** Bind the provider (an organisation administrator's own action only; audited by the kernel). */
  setBinding(
    contract: string,
    provider: string | null,
  ): Promise<
    | { status: "ok"; provider: string | null; previous: string | null }
    | { status: "error"; error: { code: string; message: string } }
  >
}
export * from "./conformance"
