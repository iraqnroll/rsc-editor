/**
 * @rsc-editor/render -- RuneScape Classic geometry and shading.
 *
 * Framework-agnostic by design: takes sector lanes and config definitions, and
 * returns plain typed arrays ready to become a BufferGeometry. No React, no
 * three.js scene objects. That is what keeps the hard geometry logic
 * unit-testable and headless-renderable.
 *
 * Fidelity is the whole point -- what the editor draws must match what the
 * client draws. Port from 2003scape/rsc-client; do not invent.
 *
 * Ownership: the `renderer` agent. See CLAUDE.md.
 */

export {};
