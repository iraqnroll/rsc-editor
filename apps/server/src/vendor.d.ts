/// <reference path="../../../packages/cache/src/vendor.d.ts" />

/**
 * The export route imports `@rsc-editor/cache`, which resolves to its
 * TypeScript source and so brings its untyped `@2003scape/*` imports into this
 * program. Their ambient declarations are referenced, not copied, for the same
 * reason `tools/import-cache/src/vendor.d.ts` gives: copies drift.
 */

export {};
