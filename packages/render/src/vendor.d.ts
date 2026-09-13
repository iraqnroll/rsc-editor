/// <reference path="../../cache/src/vendor.d.ts" />

/**
 * `@rsc-editor/cache` resolves to its TypeScript source, so typechecking this
 * package typechecks that one too -- including its imports of the untyped
 * `@2003scape/*` packages. Those ambient declarations live in
 * `packages/cache/src/vendor.d.ts`, which is not in this package's program
 * because nothing imports it.
 *
 * Referencing it rather than copying it deliberately: two copies of the same
 * ambient module declaration would drift, and the one that drifted would stop
 * catching the upstream change it exists to catch.
 */

export {};
