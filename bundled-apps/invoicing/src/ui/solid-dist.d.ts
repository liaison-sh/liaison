// bun/node resolves the bare "solid-js" specifier to the SSR build ("dist/server.js"),
// which has no reactive graph: mapArray/indexArray never re-invoke on update there. The
// reactive-graph tests in Editor.test.tsx import the deep "dist/solid.js" entry point
// directly instead, deliberately, because that is the actual runtime primitive Vite
// resolves the app to (its "browser" export condition) - not a test-only substitute.
// That deep path has no shipped type declarations, so give it just enough of a type
// here for the two primitives the test uses.
declare module "solid-js/dist/solid.js" {
  export function createRoot<T>(fn: (dispose: () => void) => T): T
  export function createSignal<T>(value: T): [() => T, (value: T) => T]
  export function createMemo<T>(fn: (prev?: T) => T): () => T
  export function indexArray<T, U>(
    list: () => readonly T[],
    mapFn: (value: () => T, index: number) => U,
  ): () => U[]
  export function mapArray<T, U>(
    list: () => readonly T[],
    mapFn: (value: T, index: () => number) => U,
  ): () => U[]
}
