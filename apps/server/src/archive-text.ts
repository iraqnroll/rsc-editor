/**
 * Text a definition can hold.
 *
 * rsc-config writes each string one byte per character, and the 204 client
 * draws them with a font of printable ASCII. Anything else comes back out of
 * config85.jag mangled and cut short -- "Hans’s nephew" returns as "Hansâs
 * neph" -- and the export then refuses the whole world over it. The shipped
 * cache has no such character anywhere, so allowing only printable ASCII
 * rules out nothing real.
 */

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** The first string in `value` the archive cannot hold, and where it is. */
export function unencodableText(value: unknown, path = ''): { path: string; char: string } | null {
  if (typeof value === 'string') {
    if (PRINTABLE_ASCII.test(value)) return null;
    const char = [...value].find((c) => !PRINTABLE_ASCII.test(c))!;
    return { path: path || '(text)', char };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = unencodableText(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      const found = unencodableText(v, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}

/** A sentence for the user, or null when the text is fine. */
export function textProblem(value: unknown): string | null {
  const found = unencodableText(value);
  if (!found) return null;
  const shown = found.char === '’' || found.char === '‘' ? `${found.char} (a typographic quote; use ')` : found.char;
  return `${found.path} contains "${shown}", which the game cannot store or draw: use plain letters, digits and ASCII punctuation`;
}
