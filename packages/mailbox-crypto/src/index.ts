// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Seal-safe entrypoint. Everything reachable from this file may run on the
// server. It must never reach a module listed in CLIENT_ONLY_MODULES: the
// server seals, it never opens. Client-only code is reached through
// `./client` instead.
//
// `apps/api` should import the named seal modules rather than this root, since
// a root export surface can drift; T-SEC-1 bans an `apps/api` import of the
// package root for that reason.
export * from "./aad"
export * from "./ack"
export * from "./blob"
export * from "./bytes"
export { CLIENT_ONLY_MODULES, type ClientOnlyModule } from "./client-only-manifest"
export * from "./field-seal"
export * from "./field-verify"
export * from "./kdf"
export * from "./keyring-attestation"
export * from "./seal"
export * from "./stream-seal"
