// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The executor parity suite's throwaway credentials (executor-parity.suite.ts):
// the cell key the loader stand-in checks, a carrier API key the host injects,
// and a secret only the app holds. None is a real credential; the suite scans
// every bridge answer for them.
export const CELL_KEY = "parity-cell-key-0123456789abcdef"
export const CARRIER_KEY = "carrier-api-key-7f3e9a1c55d2"
export const APP_SECRET = "carrier-app-held-secret-4b8d1e"
