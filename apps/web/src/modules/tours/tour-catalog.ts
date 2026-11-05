// SPDX-License-Identifier: FSL-1.1-ALv2
import { findTour, type Tour } from "@liaison/shared"

/**
 * Tour definitions the web can play. Test fixtures resolve in development
 * builds (the dev server Playwright drives, vitest) and never in production.
 */
export function resolveTour(tourId: string): Tour | undefined {
  return findTour(tourId, { includeTestTours: import.meta.env.DEV })
}
