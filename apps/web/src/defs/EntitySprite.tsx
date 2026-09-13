/**
 * One sprite out of the packed entity sheet.
 *
 * Drawn as a CSS background window onto the sheet rather than a cropped canvas:
 * the item list shows hundreds of these while scrolling, and a background-position
 * costs nothing to create and nothing to redraw.
 *
 * Four honest states, because a definition editor that shows a confidently
 * wrong icon is worse than one that shows none:
 *
 *   - no sprite id on this definition  -> "none"
 *   - the sheet has not been imported  -> the index, with a title saying why
 *   - the sheet has no cell for the id -> "?", which means the cache disagrees
 *     with itself and is worth seeing
 *   - a cell                            -> the sprite, nearest-neighbour, because
 *     these are 32-ish pixel pixel-art icons and smoothing turns them to mush
 */

import { useEntitySprites } from '../data/useCacheAssets.js';

export interface EntitySpriteProps {
  /** `items.sprite`, or null when the definition has no sprite. */
  spriteId: number | null;
  /** Box size in CSS pixels; the sprite is scaled to fit and centred. */
  size?: number;
  label?: string;
  /** No frame. For list rows, where 1290 boxed cells is visual noise. */
  plain?: boolean;
}

export function EntitySprite({ spriteId, size = 32, label, plain }: EntitySpriteProps) {
  const { status, sheet, url } = useEntitySprites();

  const box = {
    width: size,
    height: size,
    flex: `0 0 ${size}px`,
    display: 'grid',
    placeItems: 'center',
    background: plain ? 'transparent' : 'var(--bg-2)',
    border: plain ? '0' : '1px solid var(--line)',
    borderRadius: 'var(--radius)',
    color: 'var(--fg-2)',
    fontFamily: 'var(--mono)',
    fontSize: Math.max(8, Math.min(11, size / 3)),
    overflow: 'hidden'
  } as const;

  if (spriteId === null) {
    return (
      <div style={box} title={`${label ?? 'This definition'} has no sprite`} aria-label="no sprite">
        none
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div style={box} aria-label="loading sprite">
        …
      </div>
    );
  }

  const cell = sheet?.cells.get(spriteId);

  if (!cell || !url) {
    return (
      <div
        style={box}
        title={
          status === 'absent'
            ? `Sprite ${spriteId}. No entity sprite sheet in this project — import a cache to see item icons.`
            : status === 'error'
              ? `Sprite ${spriteId}. The sprite sheet failed to load.`
              : `Sprite ${spriteId} is not in the sheet.`
        }
        aria-label={`sprite ${spriteId}`}
      >
        {status === 'ready' ? '?' : spriteId}
      </div>
    );
  }

  // Fit, never crop: sprites are not all the same size (a two-handed sword is
  // taller than a coin), and clipping one to a square would hide half of it.
  const k = Math.min(size / cell.width, size / cell.height);

  return (
    <div style={box} title={`${label ? `${label} — ` : ''}sprite ${spriteId}`}>
      <div
        role="img"
        aria-label={`${label ?? 'sprite'} ${spriteId}`}
        style={{
          width: Math.round(cell.width * k),
          height: Math.round(cell.height * k),
          backgroundImage: `url(${url})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${Math.round((sheet?.sheet.width ?? 0) * k)}px ${Math.round((sheet?.sheet.height ?? 0) * k)}px`,
          backgroundPosition: `-${Math.round(cell.x * k)}px -${Math.round(cell.y * k)}px`,
          imageRendering: 'pixelated'
        }}
      />
    </div>
  );
}
