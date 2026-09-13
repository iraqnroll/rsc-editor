/**
 * RENDERER SEAM — live .ob3 model preview.
 *
 * The brief wants a live 3D thumbnail in the wall/scenery pickers. The geometry
 * for that comes from `packages/render` (owned by the `renderer` agent), which
 * does not expose a model builder yet, so this is a labelled placeholder rather
 * than a guess at .ob3 decoding.
 *
 * The contract when it is replaced: takes a model NAME (never an id — see
 * src/defs/models.ts for why `objectDef.model.id` is wrong for 409 of 1189
 * objects) plus a pixel size, and renders in that box. No store access.
 */

export interface ModelThumbnailProps {
  /** The model's name from `objectDef.model.name`. */
  modelName: string | null;
  size?: number;
}

export function ModelThumbnail({ modelName, size = 56 }: ModelThumbnailProps) {
  return (
    <div
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg-2)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        color: 'var(--fg-2)',
        fontSize: 9,
        fontFamily: 'var(--mono)',
        textAlign: 'center',
        overflow: 'hidden',
        wordBreak: 'break-all',
        padding: 2
      }}
      title={
        modelName
          ? `Model "${modelName}" — 3D preview arrives with packages/render`
          : 'No model on this definition'
      }
      aria-label={modelName ? `Model ${modelName}` : 'No model'}
    >
      {modelName ?? '—'}
    </div>
  );
}
