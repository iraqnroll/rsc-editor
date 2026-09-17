/**
 * NPC spawns and ground items drawn as the client draws them: camera-facing
 * pictures standing on their tile, NPCs at their definition's width and
 * height, items at 96x64 (`mudclient`'s `addSprite` sizes, in world units
 * where a tile is 128).
 *
 * Pictures are composed once per NPC or item type (`entity-compose.ts`) from
 * the project's entity sprite sheet and cached until the library changes.
 * Anything that cannot be pictured -- no sheet, or an NPC with no sprites --
 * is left to the line markers, which the caller keeps drawing for it.
 */

import { useEffect, useMemo, useState } from 'react';
import { CanvasTexture, NearestFilter, SRGBColorSpace, Vector2, type Texture } from 'three';
import type { RscConfig } from '@rsc-editor/schema';
import { tileRenderX, TILE_SIZE } from '@rsc-editor/render';
import { getApi } from '../data/api.js';
import {
  GROUND_ITEM_HEIGHT,
  GROUND_ITEM_WIDTH,
  composeItem,
  composeNpc,
  sheetReader,
  type CellReader,
  type Rgba
} from './entity-compose.js';
import type { WorldHeights } from './sector-geometry.js';
import type { ViewportEntity } from './viewport-props.js';

const BOTTOM_CENTRE = new Vector2(0.5, 0);

interface Picture {
  texture: Texture;
  width: number;
  height: number;
}

/** The sheet's pixels, decoded once per library version. */
function useSheetReader(libraryVersion: number): CellReader | null {
  const [reader, setReader] = useState<CellReader | null>(null);
  useEffect(() => {
    let alive = true;
    setReader(null);
    (async () => {
      const sheet = await getApi().loadEntitySprites();
      if (!sheet || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
      const bitmap = await createImageBitmap(new Blob([sheet.png], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return sheetReader(pixels, canvas.width, sheet.cells);
    })().then(
      (next) => alive && setReader(() => next),
      () => alive && setReader(null)
    );
    return () => {
      alive = false;
    };
  }, [libraryVersion]);
  return reader;
}

function toTexture(image: Rgba): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  return texture;
}

/**
 * Which entities got a picture, so the caller can keep markers for the rest.
 * Returned through `onPictured` as a set of entity ids.
 */
export function EntitySprites({
  entities,
  config,
  heights,
  libraryVersion,
  onPictured
}: {
  entities: readonly ViewportEntity[];
  config: RscConfig | null | undefined;
  heights: WorldHeights;
  libraryVersion: number;
  onPictured: (ids: ReadonlySet<string>) => void;
}) {
  const reader = useSheetReader(libraryVersion);

  // One picture per type, rebuilt when the sheet or the definitions change.
  const pictures = useMemo(() => {
    const out = new Map<string, Picture | null>();
    if (!reader || !config) return out;
    for (const e of entities) {
      const key = e.kind === 'npc' ? `npc:${e.npcId}` : e.kind === 'item' ? `item:${e.itemId}` : null;
      if (!key || out.has(key)) continue;
      let image: Rgba | null = null;
      if (e.kind === 'npc' && e.npcId !== undefined) {
        const npc = config.npcs[e.npcId];
        if (npc) image = composeNpc(npc, config.animations, reader);
        out.set(key, image && npc ? { texture: toTexture(image), width: npc.width, height: npc.height } : null);
      } else if (e.kind === 'item' && e.itemId !== undefined) {
        const item = config.items[e.itemId];
        if (item) image = composeItem(item.sprite, item.colour, reader);
        out.set(key, image ? { texture: toTexture(image), width: GROUND_ITEM_WIDTH, height: GROUND_ITEM_HEIGHT } : null);
      }
    }
    return out;
    // `entities` changes on every edit; the type set rarely does, so key on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, config, typeKey(entities)]);

  useEffect(() => {
    return () => {
      for (const p of pictures.values()) p?.texture.dispose();
    };
  }, [pictures]);

  const placed = useMemo(() => {
    const out: Array<{ id: string; picture: Picture; x: number; y: number; z: number; stack: number }> = [];
    const perTile = new Map<string, number>();
    for (const e of entities) {
      const key = e.kind === 'npc' ? `npc:${e.npcId}` : e.kind === 'item' ? `item:${e.itemId}` : null;
      const picture = key ? pictures.get(key) : null;
      if (!picture) continue;
      const x = tileRenderX(e.wx + 0.5);
      const z = (e.wy + 0.5) * TILE_SIZE;
      // Items on one tile stack a little, like the client's `groundItemZ`.
      const tile = `${e.kind}:${e.wx},${e.wy}`;
      const stack = perTile.get(tile) ?? 0;
      perTile.set(tile, stack + 1);
      out.push({ id: e.id, picture, x, y: heights.at(x, z), z, stack });
    }
    return out;
  }, [entities, pictures, heights]);

  useEffect(() => {
    onPictured(new Set(placed.map((p) => p.id)));
  }, [placed, onPictured]);

  return (
    <>
      {placed.map((p) => (
        <sprite
          key={p.id}
          position={[p.x, p.y + p.stack * 10, p.z]}
          scale={[p.picture.width, p.picture.height, 1]}
          center={BOTTOM_CENTRE}
          raycast={() => null}
        >
          <spriteMaterial map={p.picture.texture} alphaTest={0.5} toneMapped={false} />
        </sprite>
      ))}
    </>
  );
}

function typeKey(entities: readonly ViewportEntity[]): string {
  const keys = new Set<string>();
  for (const e of entities) {
    if (e.kind === 'npc') keys.add(`n${e.npcId}`);
    else if (e.kind === 'item') keys.add(`i${e.itemId}`);
  }
  return [...keys].sort().join(',');
}
