/**
 * A live 3D preview of one `.ob3` model, for the wall/scenery/object pickers.
 *
 * ============================================================================
 *  TAKES A NAME, NEVER AN ID.
 * ============================================================================
 *
 * `objectDef.model.id` is off by one for 409 of 1189 objects, because rsc-config
 * synthesises `config.models` with `index = models.push(name)` and `push`
 * returns the new length (DECISIONS section 8). A picker keyed on the id shows a
 * third of the cache as some other object's model, which looks like a renderer
 * bug and is a data bug. `apps/web/src/defs/models.ts#modelNameOf` is how a
 * definition gets a name out.
 *
 * The render is `packages/render`'s software rasteriser, not a WebGL canvas: a
 * picker shows dozens of these at once and a browser will not hand out dozens of
 * GL contexts. It costs about 0.4ms at 64px, uses the same geometry, the same
 * baked RSC lighting and the same atlas sampling rules the viewport uses, and is
 * memoised per (name, direction, size). See `model-thumbnail.ts`.
 *
 * Three states are drawn honestly rather than as an empty box:
 *
 *   - no models asset on this project (the route 404s until the cache is
 *     imported) -> the name, greyed;
 *   - a name the archive does not contain -> the name, marked;
 *   - anything else -> the model.
 */

import { useEffect, useRef, useState } from 'react';
import { renderModelThumbnail, type ThumbnailResult } from './model-thumbnail.js';

export interface ModelThumbnailProps {
  /** The model's name from `objectDef.model.name`. */
  modelName: string | null;
  size?: number;
  /** the `direction` lane's 0-7 facing, if previewing a specific placement */
  direction?: number;
  /** change it to redraw after the model itself changed */
  version?: number;
}

export function ModelThumbnail({ modelName, size = 56, direction = 0, version = 0 }: ModelThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<ThumbnailResult | null>(null);

  useEffect(() => {
    if (!modelName) {
      setResult(null);
      return;
    }

    let alive = true;
    setResult(null);
    renderModelThumbnail(modelName, size, { direction }).then(
      (next) => alive && setResult(next),
      // Never throw into a picker. A thumbnail that cannot draw falls back to
      // the name, which is still enough to pick with.
      () => alive && setResult({ state: 'missing', modelName })
    );
    return () => {
      alive = false;
    };
  }, [modelName, size, direction, version]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || result?.state !== 'ok') return;

    const context = canvas.getContext('2d');
    // No 2D context (jsdom, or a browser refusing one) is not an error; the
    // label underneath still identifies the model.
    if (!context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.putImageData(new ImageData(result.image.rgba, result.image.size, result.image.size), 0, 0);
  }, [result]);

  const drew = result?.state === 'ok' && result.image.visible;

  const label =
    !modelName
      ? '—'
      : result === null
        ? '…'
        : result.state === 'no-models'
          ? modelName
          : result.state === 'missing'
            ? modelName
            : modelName;

  const title = !modelName
    ? 'No model on this definition'
    : result?.state === 'no-models'
      ? `Model "${modelName}" — this project has no imported models`
      : result?.state === 'missing'
        ? `Model "${modelName}" is named by the config but is not in the archive`
        : `Model "${modelName}"`;

  return (
    <div
      style={{
        position: 'relative',
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
      title={title}
      aria-label={modelName ? `Model ${modelName}` : 'No model'}
    >
      {modelName && (
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          style={{
            position: 'absolute',
            inset: 0,
            width: size,
            height: size,
            // The render is already pixel art at thumbnail scale; smoothing it
            // makes it look like a different game, same as the atlas.
            imageRendering: 'pixelated',
            display: drew ? 'block' : 'none'
          }}
        />
      )}
      {!drew && <span style={{ position: 'relative' }}>{label}</span>}
    </div>
  );
}
