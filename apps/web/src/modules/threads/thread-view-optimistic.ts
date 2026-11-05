// SPDX-License-Identifier: FSL-1.1-ALv2
export interface OptimisticMutationStep {
  apply: () => void
  rollback: () => void
}

interface RunOptimisticMutationOptions<TResult> {
  request: () => Promise<TResult>
  steps?: readonly OptimisticMutationStep[]
  onSuccess?: (result: TResult) => void
  onError?: (error: unknown) => void
}

export async function runOptimisticMutation<TResult>({
  request,
  steps = [],
  onSuccess,
  onError,
}: RunOptimisticMutationOptions<TResult>): Promise<TResult> {
  const appliedSteps: OptimisticMutationStep[] = []

  try {
    for (const step of steps) {
      step.apply()
      appliedSteps.push(step)
    }

    const result = await request()
    onSuccess?.(result)
    return result
  } catch (error) {
    for (const step of [...appliedSteps].reverse()) {
      try {
        step.rollback()
      } catch {
        // Prefer preserving the original mutation error.
      }
    }

    onError?.(error)
    throw error
  }
}

export function createOptimisticStep(
  apply: () => void,
  rollback: () => void,
): OptimisticMutationStep {
  return { apply, rollback }
}

export function createValueStep<TValue>(
  applyValue: (value: TValue) => void,
  previousValue: TValue,
  nextValue: TValue,
): OptimisticMutationStep {
  return createOptimisticStep(
    () => applyValue(nextValue),
    () => applyValue(previousValue),
  )
}
