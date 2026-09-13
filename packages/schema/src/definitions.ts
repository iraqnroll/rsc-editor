import { z } from 'zod';

/**
 * Entity / config definitions.
 *
 * These schemas were derived from the real config85.jag shipped in
 * fixtures/data204 (not from documentation), via tools/dump-defs. Field names
 * and enum domains match @2003scape/rsc-config's output exactly, so a parsed
 * config validates as-is and the editor's forms can be generated from these.
 *
 * Colours are CSS strings ("rgb(238, 221, 221)") because that is what
 * rsc-config emits; packages/render converts them for the GPU.
 */

/**
 * Colours come out of rsc-config as CSS strings. Almost all are `rgb(r, g, b)`,
 * but the cache also uses the keyword `transparent` -- tile overlay 7 ("hole")
 * and wall object 119 ("solidblank") rely on it to punch through the floor, so
 * it is load-bearing geometry, not a missing value.
 */
const rgbString = z.union([
  z.literal('transparent'),
  z.string().regex(/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/, 'expected "rgb(r, g, b)"')
]);

/** Free-form because the cache contains ~200 distinct verbs, including typos. */
const command = z.string();

export const itemDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  command: command,
  sprite: z.number().int(),
  price: z.number().int(),
  stackable: z.boolean(),
  special: z.boolean(),
  /** null for the 949 items that cannot be worn */
  equip: z
    .array(
      z.enum([
        'head',
        'body',
        'legs',
        'feet',
        'hands',
        'cape',
        'chest',
        'left-hand',
        'right-hand',
        '2-handed',
        'replace-head',
        'replace-body',
        'replace-legs'
      ])
    )
    .nullable(),
  /** null when the item sprite is not recoloured */
  colour: rgbString.nullable(),
  untradeable: z.boolean(),
  members: z.boolean()
});
export type ItemDef = z.infer<typeof itemDefSchema>;

export const npcDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  command: command,
  attack: z.number().int(),
  strength: z.number().int(),
  hits: z.number().int(),
  defense: z.number().int(),
  hostility: z.enum(['aggressive', 'combative', 'retreats']).nullable(),
  /** always length 12; null = slot unused */
  animations: z.array(z.number().int().nullable()).length(12),
  hairColour: rgbString.nullable(),
  topColour: rgbString.nullable(),
  bottomColour: rgbString.nullable(),
  skinColour: rgbString.nullable(),
  width: z.number().int(),
  height: z.number().int(),
  walkModel: z.number().int(),
  combatModel: z.number().int(),
  combatAnimation: z.number().int()
});
export type NpcDef = z.infer<typeof npcDefSchema>;

/** Scenery. `model` links into the `models` name table. */
export const objectDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  commands: z.array(command),
  model: z.object({ name: z.string(), id: z.number().int() }),
  /** footprint in tiles; 0 occurs in the cache (object 581), so not positive-only */
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  type: z.enum(['blocked', 'unblocked', 'closed-door', 'open-door']),
  itemHeight: z.number().int()
});
export type ObjectDef = z.infer<typeof objectDefSchema>;

/** Boundaries: the walls that sit on tile edges. */
export const wallObjectDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  commands: z.array(command),
  height: z.number().int(),
  colourFront: rgbString.nullable(),
  textureFront: z.number().int().nullable(),
  colourBack: rgbString.nullable(),
  textureBack: z.number().int().nullable(),
  blocked: z.boolean(),
  invisible: z.boolean()
});
export type WallObjectDef = z.infer<typeof wallObjectDefSchema>;

export const roofDefSchema = z.object({
  height: z.number().int(),
  texture: z.number().int()
});
export type RoofDef = z.infer<typeof roofDefSchema>;

/** Ground overlays -- what `tileDecoration` indexes into. */
export const tileDefSchema = z.object({
  /** null when the overlay is textured rather than flat-coloured */
  colour: rgbString.nullable(),
  texture: z.number().int().nullable(),
  type: z.enum(['ground', 'floor', 'liquid', 'bridge', 'hole']).nullable(),
  blocked: z.boolean()
});
export type TileDef = z.infer<typeof tileDefSchema>;

export const textureDefSchema = z.object({
  name: z.string(),
  subName: z.string()
});
export type TextureDef = z.infer<typeof textureDefSchema>;

export const animationDefSchema = z.object({
  name: z.string(),
  colour: rgbString,
  genderModel: z.number().int(),
  hasA: z.boolean(),
  hasF: z.boolean()
});
export type AnimationDef = z.infer<typeof animationDefSchema>;

export const spellDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  level: z.number().int(),
  type: z.enum(['offensive', 'self', 'object', 'inventory']),
  runes: z.array(z.object({ id: z.number().int(), amount: z.number().int() }))
});
export type SpellDef = z.infer<typeof spellDefSchema>;

export const prayerDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  level: z.number().int(),
  drain: z.number().int()
});
export type PrayerDef = z.infer<typeof prayerDefSchema>;

/**
 * The registry the definition editor is generated from. Adding a kind here is
 * all that is needed for it to gain an editor form.
 */
export const definitionSchemas = {
  items: itemDefSchema,
  npcs: npcDefSchema,
  objects: objectDefSchema,
  wallObjects: wallObjectDefSchema,
  roofs: roofDefSchema,
  tiles: tileDefSchema,
  textures: textureDefSchema,
  animations: animationDefSchema,
  spells: spellDefSchema,
  prayers: prayerDefSchema
} as const;

export type DefinitionKind = keyof typeof definitionSchemas;

export const definitionKindSchema = z.enum(
  Object.keys(definitionSchemas) as [DefinitionKind, ...DefinitionKind[]]
);

/** Full parsed config, as held in memory and persisted per project. */
export const configSchema = z.object({
  items: z.array(itemDefSchema),
  npcs: z.array(npcDefSchema),
  objects: z.array(objectDefSchema),
  wallObjects: z.array(wallObjectDefSchema),
  roofs: z.array(roofDefSchema),
  tiles: z.array(tileDefSchema),
  textures: z.array(textureDefSchema),
  animations: z.array(animationDefSchema),
  spells: z.array(spellDefSchema),
  prayers: z.array(prayerDefSchema),
  /** model name table; objectDef.model.id indexes into this */
  models: z.array(z.string())
});
export type RscConfig = z.infer<typeof configSchema>;
