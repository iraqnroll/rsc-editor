/**
 * NPC and ground-item pictures, composed the way rsc-client 204 draws them.
 *
 * Pure pixel work on RGBA, so it is testable without a DOM. The inputs are
 * cells of the entity sprite sheet, which the importer renders full-box
 * (every frame expanded to its group's box) with the cache's own colours.
 *
 * ## An NPC is up to 12 layers (`mudclient#drawNpc`)
 *
 * `npc.animations[slot]` names an animation definition per slot (head, body,
 * legs, weapons...). The layers are drawn in a per-facing order; each one's
 * full box is stretched to the NPC's width and height. The editor shows the
 * front view, facing index 0, walk frame 0: sprite id
 * `ANIMATION_SPRITE_BASE + animation * 27 + 0`.
 *
 * ## Recolouring (`Surface#_spriteClipping_from9` and its plotters)
 *
 * - a grey pixel (r == g == b) is multiplied by the layer colour, per channel,
 *   `(c * k) >> 8`;
 * - with a skin colour, a pixel with r == 255 and g == b is multiplied by it;
 * - anything else is drawn as is. A colour of 0 means white (no change).
 *
 * The layer colour comes from the animation definition: 1, 2 and 3 mean the
 * NPC's hair, top and bottom colour (and then the NPC's skin colour applies);
 * any other value is used as is. NPC colours are used exactly as stored --
 * many NPCs store 1 or 2, which multiplies to near-black, and that is what the
 * client draws.
 *
 * An item is one sprite, tinted by `item.colour` with the same grey rule.
 */

/** One entry of rsc-client's `npcAnimationArray`: facing 0, the front view. */
export const NPC_LAYER_ORDER_FRONT = [11, 2, 9, 7, 1, 6, 10, 0, 5, 8, 3, 4] as const;

/** `ANIMATION_SPRITE_BASE` / `ANIMATION_SPRITE_STRIDE` in @rsc-editor/cache. */
export const ANIMATION_SPRITE_BASE = 1000;
export const ANIMATION_SPRITE_STRIDE = 27;

/** World size of a ground item, from `mudclient`'s `addSprite(…, 96, 64, …)`. */
export const GROUND_ITEM_WIDTH = 96;
export const GROUND_ITEM_HEIGHT = 64;

export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Reads one sheet cell as RGBA; null when the sheet has no such sprite. */
export type CellReader = (spriteId: number) => Rgba | null;

export interface NpcLook {
  animations: ReadonlyArray<number | null>;
  hairColour: string | null;
  topColour: string | null;
  bottomColour: string | null;
  skinColour: string | null;
}

export interface AnimationLook {
  colour: string | null;
}

/** 'rgb(r, g, b)' -> 0xRRGGBB; null, 'transparent' and junk -> 0 (no tint). */
export function colourInt(value: string | null | undefined): number {
  if (!value) return 0;
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);
  if (!m) return 0;
  return (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]);
}

/** Draw `src` stretched over `dest`, recoloured, skipping transparent pixels. */
function blit(dest: Rgba, src: Rgba, colour: number, skin: number): void {
  const tint = colour === 0 ? 0xffffff : colour;
  const skinTint = skin === 0 ? 0xffffff : skin;
  const [tr, tg, tb] = [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255];
  const [sr, sg, sb] = [(skinTint >> 16) & 255, (skinTint >> 8) & 255, skinTint & 255];
  const useSkin = skinTint !== 0xffffff;
  for (let y = 0; y < dest.height; y++) {
    const sy = Math.floor((y * src.height) / dest.height);
    for (let x = 0; x < dest.width; x++) {
      const sx = Math.floor((x * src.width) / dest.width);
      const s = (sy * src.width + sx) * 4;
      if (src.data[s + 3]! < 128) continue;
      const r = src.data[s]!;
      const g = src.data[s + 1]!;
      const b = src.data[s + 2]!;
      const d = (y * dest.width + x) * 4;
      if (r === g && g === b) {
        dest.data[d] = (r * tr) >> 8;
        dest.data[d + 1] = (g * tg) >> 8;
        dest.data[d + 2] = (b * tb) >> 8;
      } else if (useSkin && r === 255 && g === b) {
        dest.data[d] = (r * sr) >> 8;
        dest.data[d + 1] = (g * sg) >> 8;
        dest.data[d + 2] = (b * sb) >> 8;
      } else {
        dest.data[d] = r;
        dest.data[d + 1] = g;
        dest.data[d + 2] = b;
      }
      dest.data[d + 3] = 255;
    }
  }
}

/**
 * An NPC, front view. The picture is as large as its largest layer's box, so
 * nothing is scaled down; the caller stretches it to `npc.width x npc.height`
 * in the world, as the client does. Null when no layer has a sprite.
 */
export function composeNpc(
  npc: NpcLook,
  animations: readonly AnimationLook[],
  cell: CellReader
): Rgba | null {
  const layers: Array<{ image: Rgba; colour: number; skin: number }> = [];
  for (const slot of NPC_LAYER_ORDER_FRONT) {
    const anim = npc.animations[slot];
    if (anim === null || anim === undefined || anim < 0) continue;
    const image = cell(ANIMATION_SPRITE_BASE + anim * ANIMATION_SPRITE_STRIDE);
    if (!image) continue;
    let colour = colourInt(animations[anim]?.colour);
    let skin = 0;
    if (colour === 1 || colour === 2 || colour === 3) {
      const which = colour === 1 ? npc.hairColour : colour === 2 ? npc.topColour : npc.bottomColour;
      colour = colourInt(which);
      skin = colourInt(npc.skinColour);
    }
    layers.push({ image, colour, skin });
  }
  if (layers.length === 0) return null;

  const width = Math.max(...layers.map((l) => l.image.width));
  const height = Math.max(...layers.map((l) => l.image.height));
  const out: Rgba = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (const layer of layers) blit(out, layer.image, layer.colour, layer.skin);
  return out;
}

/** A ground item: its sprite, tinted by the item's colour. */
export function composeItem(sprite: number, colour: string | null, cell: CellReader): Rgba | null {
  const image = cell(sprite);
  if (!image) return null;
  const out: Rgba = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data.length) };
  blit(out, image, colourInt(colour), 0);
  return out;
}

/** A reader over the sheet's decoded pixels and its cell table. */
export function sheetReader(
  pixels: Uint8ClampedArray,
  sheetWidth: number,
  cells: ReadonlyMap<number, { x: number; y: number; width: number; height: number }>
): CellReader {
  return (spriteId) => {
    const c = cells.get(spriteId);
    if (!c) return null;
    const data = new Uint8ClampedArray(c.width * c.height * 4);
    for (let y = 0; y < c.height; y++) {
      const from = ((c.y + y) * sheetWidth + c.x) * 4;
      data.set(pixels.subarray(from, from + c.width * 4), y * c.width * 4);
    }
    return { width: c.width, height: c.height, data };
  };
}
