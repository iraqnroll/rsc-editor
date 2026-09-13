/**
 * Ambient types for the @2003scape packages, which ship as untyped JavaScript.
 *
 * These are part of the contract layer, not a convenience: they are the only
 * thing standing between a typo and a silently corrupted cache. Keep them
 * narrow -- declare only what we actually call, so an upstream change that
 * removes a method we rely on surfaces as a type error rather than at runtime.
 *
 * Pinned against rsc-archiver@1.1.1 and rsc-config@1.0.1. See docs/DECISIONS.md
 * for why we are on the v1 archiver line.
 */

declare module '@2003scape/rsc-archiver' {
  /** Jagex filename hash used as the entry key. */
  export function hashFilename(filename: string): number;

  export class JagArchive {
    /** hash -> raw entry bytes */
    entries: Map<number, Uint8Array>;

    readArchive(buffer: Uint8Array): void;
    getEntry(name: string): Uint8Array;
    putEntry(filename: string, entry: Uint8Array): void;
    /** `individualCompress` compresses each entry separately (.jag style) */
    toArchive(individualCompress?: boolean): Uint8Array;
  }
}

declare module '@2003scape/rsc-config' {
  import type { RscConfig } from '@rsc-editor/schema';

  export class Config extends Object {
    loadArchive(buffer: Uint8Array): void;
    toArchive(): Uint8Array;
  }

  export interface Config extends RscConfig {}
}
