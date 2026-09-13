/**
 * The header above a generated definition form: what this thing actually looks
 * like, plus the two or three facts the form's own fields do not make obvious.
 *
 * Per kind:
 *
 *   items       - the real sprite, from `items.sprite`. That index IS in the
 *                 cache, which is why the item editor gets a picture and the
 *                 others mostly do not.
 *   npcs        - a sprite only if the sheet layout supplies an npc -> sprite
 *                 map. An NPC definition carries 12 *animation* indices and the
 *                 client composites a body from them; there is no npc sprite
 *                 index to read, so guessing one would teach a wrong number.
 *   objects     - the model BY NAME, never `model.id`, which is off by one for
 *                 409 of 1189 objects (DECISIONS §8). When the two disagree the
 *                 header says so, because that discrepancy is exactly the thing
 *                 that makes a third of the cache render as the wrong model.
 *   wallObjects - front/back fills. Walls are not .ob3 models at all: they are
 *                 a colour or a texture per side, and `transparent` is a hole
 *                 (wall object 119, "solidblank"), not an unset value.
 *   tiles       - the overlay's own colour, with the same transparent rule.
 *
 * ALSO, because sprites invite the assumption: the cache contains no NPC or
 * ground-item *placements*. Nothing here implies an NPC can be put in the world.
 */

import type { RscConfig } from '@rsc-editor/schema';
import { ModelThumbnail } from '../scene/ModelThumbnail.js';
import { useEntitySprites } from '../data/useCacheAssets.js';
import { spriteIdFor } from '../data/entity-sprites.js';
import { ColourSwatch } from './ColourField.js';
import { EntitySprite } from './EntitySprite.js';
import { modelIndexOf, modelNameOf } from './models.js';

export interface DefinitionPreviewProps {
  kind: string;
  index: number;
  entry: Record<string, unknown>;
  config: RscConfig | null;
}

/** The kinds that have something to show. The other five are numbers and text. */
const PREVIEWABLE = new Set(['items', 'npcs', 'objects', 'wallObjects', 'tiles']);

export function DefinitionPreview({ kind, index, entry, config }: DefinitionPreviewProps) {
  const { sheet } = useEntitySprites();

  const name = typeof entry.name === 'string' ? entry.name : `#${index}`;
  const description = typeof entry.description === 'string' ? entry.description : '';

  // Hooks first, then bail: a conditional `useEntitySprites` would break the
  // rules of hooks the moment someone switches kinds.
  if (!PREVIEWABLE.has(kind)) return null;

  return (
    <div className="defpreview">
      <PreviewMedia kind={kind} index={index} entry={entry} config={config} sheet={sheet} />
      <div className="defpreview__text">
        <div className="defpreview__name">{name}</div>
        {description && <div className="hint">{description}</div>}
        <PreviewFacts kind={kind} index={index} entry={entry} config={config} sheet={sheet} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- media -- */

function PreviewMedia({
  kind,
  index,
  entry,
  config,
  sheet
}: DefinitionPreviewProps & { sheet: ReturnType<typeof useEntitySprites>['sheet'] }) {
  if (kind === 'items' || kind === 'npcs') {
    return (
      <EntitySprite spriteId={spriteIdFor(kind, index, entry, sheet)} size={56} label={kind} />
    );
  }

  if (kind === 'objects') {
    // The seam: `src/scene/ModelThumbnail.tsx` belongs to the renderer agent and
    // renders the model name as a labelled placeholder until it can draw .ob3.
    // It takes a NAME, and always will — see src/defs/models.ts.
    return <ModelThumbnail modelName={modelNameOf(entry)} size={56} />;
  }

  if (kind === 'wallObjects') {
    return <WallPreview entry={entry} config={config} />;
  }

  if (kind === 'tiles') {
    const colour = typeof entry.colour === 'string' ? entry.colour : null;
    return (
      <div className="defpreview__media">
        <ColourSwatch value={colour} />
      </div>
    );
  }

  return null;
}

/** A wall is a fill per side, not a model. Both sides, both nullable. */
function WallPreview({
  entry,
  config
}: {
  entry: Record<string, unknown>;
  config: RscConfig | null;
}) {
  const sides = [
    { label: 'front', colour: entry.colourFront, texture: entry.textureFront },
    { label: 'back', colour: entry.colourBack, texture: entry.textureBack }
  ] as const;

  return (
    <div className="defpreview__media defpreview__media--wall">
      {sides.map((side) => (
        <div key={side.label} className="defpreview__side">
          <ColourSwatch value={typeof side.colour === 'string' ? side.colour : null} />
          <span className="hint">
            {side.label}
            {/* `texture: 0` is a real texture. Check the shape, never truthiness. */}
            {typeof side.texture === 'number'
              ? ` · tex ${side.texture}${
                  config?.textures?.[side.texture]?.name
                    ? ` (${config.textures[side.texture]?.name})`
                    : ''
                }`
              : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- facts -- */

function PreviewFacts({
  kind,
  index,
  entry,
  config,
  sheet
}: DefinitionPreviewProps & { sheet: ReturnType<typeof useEntitySprites>['sheet'] }) {
  if (kind === 'items') {
    const sprite = typeof entry.sprite === 'number' ? entry.sprite : null;
    const equip = Array.isArray(entry.equip) ? entry.equip : null;
    return (
      <div className="defpreview__facts">
        <span>sprite {sprite ?? 'none'}</span>
        {/* equip and colour are null for most items; say "none", not blank. */}
        <span>equip {equip && equip.length > 0 ? equip.join(', ') : 'none'}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          colour{' '}
          {typeof entry.colour === 'string' ? (
            <>
              <ColourSwatch value={entry.colour} />
              {entry.colour}
            </>
          ) : (
            'none'
          )}
        </span>
        {entry.members === true && <span className="row__tag">members</span>}
      </div>
    );
  }

  if (kind === 'npcs') {
    const mapped = spriteIdFor('npcs', index, entry, sheet);
    return (
      <div className="defpreview__facts">
        {mapped === null && (
          <span
            className="hint"
            title="npcs have 12 animation indices, not a sprite index. The sheet would have to publish an npc -> sprite map for an icon to be correct."
          >
            no sprite index on an NPC definition
          </span>
        )}
        <span>
          {String(entry.attack ?? 0)}/{String(entry.strength ?? 0)}/{String(entry.hits ?? 0)}/
          {String(entry.defense ?? 0)} atk/str/hp/def
        </span>
        <span>{typeof entry.hostility === 'string' ? entry.hostility : 'passive (null)'}</span>
      </div>
    );
  }

  if (kind === 'objects') {
    const modelName = modelNameOf(entry);
    const model = entry.model as { id?: unknown } | undefined;
    const declaredId = typeof model?.id === 'number' ? model.id : null;
    const resolved = modelIndexOf(config?.models ?? [], modelName);
    const width = typeof entry.width === 'number' ? entry.width : 0;
    const heightTiles = typeof entry.height === 'number' ? entry.height : 0;

    return (
      <div className="defpreview__facts">
        <span>
          model <strong>{modelName ?? 'none'}</strong>
        </span>
        <span title="objects[581] really is 0x0 in the cache; a zero footprint is data, not a bug.">
          {width} x {heightTiles}
          {width === 0 && heightTiles === 0 ? ' (real 0x0)' : ''}
        </span>
        {declaredId !== null && resolved >= 0 && declaredId !== resolved && (
          <span
            className="defpreview__warn"
            title="rsc-config builds the model table with `index = models.push(name)`, which returns the new length. 409 of 1189 objects carry an id one too high. The editor resolves by name."
          >
            model.id {declaredId} is stale — name resolves to {resolved}
          </span>
        )}
      </div>
    );
  }

  if (kind === 'wallObjects') {
    return (
      <div className="defpreview__facts">
        <span>height {String(entry.height ?? 0)}</span>
        {entry.blocked === true && <span className="row__tag">blocked</span>}
        {entry.invisible === true && <span className="row__tag">invisible</span>}
        {(entry.colourFront === 'transparent' || entry.colourBack === 'transparent') && (
          <span className="defpreview__warn" title="A hole in the geometry, not an unset colour.">
            transparent side
          </span>
        )}
      </div>
    );
  }

  if (kind === 'tiles') {
    return (
      <div className="defpreview__facts">
        <span>overlay index {index + 1}</span>
        <span>{typeof entry.type === 'string' ? entry.type : 'untyped'}</span>
        {entry.colour === 'transparent' && (
          <span className="defpreview__warn">transparent — a hole</span>
        )}
      </div>
    );
  }

  return null;
}
