/**
 * Resolving a scenery/wall definition to its .ob3 model.
 *
 * ============================================================================
 *  NEVER key off `objectDef.model.id`. Use `objectDef.model.name`.
 * ============================================================================
 *
 * `config.models` is not a real section of config85.jag — rsc-config
 * synthesises it with `index = this.models.push(name)`, and `Array#push`
 * returns the new *length*, not the new index. So the first object to mention
 * each model name records `id + 1`. Object 0 ("Tree") has model.name "tree2"
 * and model.id 1, while models[1] is "tree" and models[0] is "tree2".
 *
 * 409 of 1189 objects carry a wrong id. Keying a picker or a preview off the id
 * shows the wrong model for a third of the cache, and it looks like a renderer
 * bug rather than a data bug.
 *
 * `packages/cache` exports `modelIndexOf()` for this. apps/web does not depend
 * on @rsc-editor/cache, so the name->index lookup is reimplemented here over
 * `config.models`; if apps/web ever gains that dependency, delete this and call
 * `modelIndexOf` instead.
 */

/** The model's name, which is the only reliable key. */
export function modelNameOf(entry: Record<string, unknown> | undefined): string | null {
  const model = entry?.model;
  if (model && typeof model === 'object' && 'name' in model) {
    const name = (model as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return null;
}

/** First index in the model name table matching `name`, or -1. */
export function modelIndexOf(models: readonly string[], name: string | null): number {
  if (name === null) return -1;
  return models.indexOf(name);
}

/**
 * `texture: 0` is a real texture, not an absence. Anything that decides whether
 * a texture is set must check the shape, never truthiness.
 */
export function hasTexture(value: unknown): value is number {
  return typeof value === 'number';
}

/**
 * Pure green (#00ff00) in a texture palette is a cutout — it punches a hole
 * through geometry the same way the `transparent` colour keyword does. Any
 * texture-palette UI must preserve it rather than treat it as a stray colour.
 */
export const TEXTURE_CUTOUT_HEX = '#00ff00';
