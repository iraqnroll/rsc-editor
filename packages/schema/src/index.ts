/**
 * @rsc-editor/schema -- the contract layer.
 *
 * Every other package depends on this one and none of them may fork it. It is
 * the seam that lets the cache, renderer, realtime, api and ui packages be
 * built independently without their interfaces drifting apart.
 *
 * Ownership: the `schema` agent. See CLAUDE.md.
 */
export * from './constants.js';
export * from './sector.js';
export * from './wire.js';
export * from './ops.js';
export * from './protocol.js';
export * from './definitions.js';
