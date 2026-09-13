import { Config } from '@2003scape/rsc-config';
import { configSchema, type RscConfig } from '@rsc-editor/schema';

/**
 * Entity/config definitions.
 *
 * Unlike the landscape, config archives do NOT repack byte-identically: bzip2
 * block framing differs, so a repack of an untouched config85.jag comes back a
 * few hundred bytes larger. That is cosmetic -- the client parses the archive,
 * it does not checksum it -- so the guarantee we hold ourselves to here is
 * *semantic*: every definition must survive a pack/reload cycle unchanged.
 * `assertConfigRoundTrip` is what enforces that before an export is offered.
 */

export function loadConfig(archive: Uint8Array): RscConfig {
  const config = new Config();
  config.loadArchive(archive);
  return configSchema.parse(toPlain(config));
}

export function exportConfig(source: RscConfig, original: Uint8Array): Uint8Array {
  // rsc-config writes from its own instance state, so start from a parsed
  // archive and overlay our edited definitions onto it.
  const config = new Config();
  config.loadArchive(original);
  Object.assign(config, source);
  return config.toArchive();
}

/** Strip class machinery, keeping only the definition arrays we model. */
function toPlain(config: Config): unknown {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(configSchema.shape)) {
    out[key] = (config as unknown as Record<string, unknown>)[key];
  }
  return out;
}

/**
 * Pack -> reload -> deep-compare. Throws with the offending definition kinds.
 * Run this before handing a user an exported cache.
 */
export function assertConfigRoundTrip(
  source: RscConfig,
  original: Uint8Array
): void {
  const packed = exportConfig(source, original);
  const reloaded = loadConfig(packed);

  const broken: string[] = [];
  for (const key of Object.keys(configSchema.shape) as (keyof RscConfig)[]) {
    if (JSON.stringify(source[key]) !== JSON.stringify(reloaded[key])) {
      broken.push(key);
    }
  }

  if (broken.length > 0) {
    throw new Error(
      `config round-trip lost data in: ${broken.join(', ')}. Refusing to export.`
    );
  }
}
