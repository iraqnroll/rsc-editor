/**
 * Adding definitions (apps/server `routes/definitions.ts`): a copy of an
 * existing one, or a new row, at the end of its table. Live backend only.
 */

import type { DefinitionKind } from '@rsc-editor/schema';
import { getApi } from './api.js';
import { apiJson } from './http.js';

/** Tables the server lets you add to, and what limits them there. */
export const ADDABLE_KINDS: readonly DefinitionKind[] = ['objects', 'items', 'npcs', 'wallObjects'];

export async function duplicateDefinition(
  kind: DefinitionKind,
  copyOf: number,
  changes: Record<string, unknown> = {}
): Promise<number> {
  // The project routes hang off the same prefix as the library's.
  const project = getApi().libraryPath()?.replace(/\/library$/, '');
  if (!project) throw new Error('no project is open');
  const body = await apiJson<{ index: number }>(`${project}/definitions/${kind}`, {
    method: 'POST',
    body: JSON.stringify({ copyOf, changes })
  });
  return body.index;
}
