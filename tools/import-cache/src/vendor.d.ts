/// <reference path="../../../packages/cache/src/vendor.d.ts" />

/**
 * `@rsc-editor/cache` resolves to its TypeScript source, so typechecking this
 * tool typechecks that package too -- including its imports of the untyped
 * `@2003scape/*` packages. Those ambient declarations live in
 * `packages/cache/src/vendor.d.ts`, which is not otherwise in this program.
 *
 * Referenced rather than copied, for the same reason `packages/render` does it:
 * two copies of one ambient declaration drift, and the copy that drifts stops
 * catching the upstream change it exists to catch.
 */

export {};
