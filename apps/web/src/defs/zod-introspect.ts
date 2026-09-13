/**
 * Zod schema -> a small field tree the form renderer can walk.
 *
 * Two deliberate choices:
 *
 * 1. **We do not import zod.** `zod` is a dependency of @rsc-editor/schema, not
 *    of apps/web, and adding it would mean touching apps/web/package.json (and
 *    the lockfile) for no gain. Zod 3's `_def` is a stable, documented-enough
 *    internal shape, and we only read it. If zod 4's classic export ever lands
 *    here, `typeName` is the one thing to re-check.
 *
 * 2. **The tree is derived, never hand-maintained.** Ten definition kinds with
 *    hand-written forms drift from the data the moment the cache audit finds
 *    another nullable field. `definitionSchemas` in @rsc-editor/schema is the
 *    single source; adding a kind there gives it a form here for free.
 *
 * The one piece of domain knowledge encoded here is `colour`: the union
 * `literal("transparent") | string.regex(rgb)` is recognised and collapsed into
 * a single node, because "transparent" is load-bearing geometry (DECISIONS §6)
 * and must survive a round trip through the control unchanged.
 */

/** Structural stand-in for a zod schema, so we need no zod import. */
export interface ZodLike {
  _def: ZodDef;
}

interface ZodDef {
  typeName: string;
  checks?: Array<{ kind: string; value?: unknown; regex?: RegExp }>;
  values?: string[];
  value?: unknown;
  innerType?: ZodLike;
  schema?: ZodLike;
  type?: ZodLike;
  options?: ZodLike[];
  shape?: () => Record<string, ZodLike>;
  exactLength?: { value: number } | null;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  keyType?: ZodLike;
  valueType?: ZodLike;
}

export type FieldNode =
  | { kind: 'string'; pattern: string | null }
  | { kind: 'number'; int: boolean; min: number | null; max: number | null }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'literal'; value: unknown }
  /** `"transparent" | "rgb(r, g, b)"` — see the header. */
  | { kind: 'colour' }
  | { kind: 'nullable'; inner: FieldNode }
  | { kind: 'optional'; inner: FieldNode }
  | {
      kind: 'array';
      element: FieldNode;
      exactLength: number | null;
      min: number | null;
      max: number | null;
    }
  | { kind: 'object'; fields: Array<{ name: string; node: FieldNode }> }
  | { kind: 'union'; options: FieldNode[] }
  | { kind: 'unknown'; typeName: string };

function isZodLike(v: unknown): v is ZodLike {
  return (
    typeof v === 'object' &&
    v !== null &&
    '_def' in v &&
    typeof (v as { _def?: unknown })._def === 'object'
  );
}

/**
 * Recognise the rgb-string union from @rsc-editor/schema's `rgbString`.
 * Matching on structure rather than on a field name keeps this working if the
 * schema owner renames `colour` to `colourFront` (they already did, twice).
 */
function isColourUnion(options: ZodLike[]): boolean {
  if (options.length !== 2) return false;
  const literal = options.find((o) => o._def.typeName === 'ZodLiteral');
  const str = options.find((o) => o._def.typeName === 'ZodString');
  return !!literal && !!str && literal._def.value === 'transparent';
}

export function introspect(schema: unknown, depth = 0): FieldNode {
  if (!isZodLike(schema) || depth > 12) return { kind: 'unknown', typeName: 'unknown' };
  const def = schema._def;

  switch (def.typeName) {
    case 'ZodString': {
      const regex = def.checks?.find((c) => c.kind === 'regex')?.regex;
      return { kind: 'string', pattern: regex ? regex.source : null };
    }

    case 'ZodNumber': {
      const checks = def.checks ?? [];
      const min = checks.find((c) => c.kind === 'min')?.value;
      const max = checks.find((c) => c.kind === 'max')?.value;
      return {
        kind: 'number',
        int: checks.some((c) => c.kind === 'int'),
        min: typeof min === 'number' ? min : null,
        max: typeof max === 'number' ? max : null
      };
    }

    case 'ZodBoolean':
      return { kind: 'boolean' };

    case 'ZodEnum':
      return { kind: 'enum', values: def.values ?? [] };

    case 'ZodLiteral':
      return { kind: 'literal', value: def.value };

    case 'ZodNullable':
      return { kind: 'nullable', inner: introspect(def.innerType, depth + 1) };

    case 'ZodOptional':
      return { kind: 'optional', inner: introspect(def.innerType, depth + 1) };

    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodBranded':
    case 'ZodReadonly':
      return introspect(def.innerType, depth + 1);

    case 'ZodEffects':
      return introspect(def.schema, depth + 1);

    case 'ZodArray':
      return {
        kind: 'array',
        element: introspect(def.type, depth + 1),
        exactLength: def.exactLength?.value ?? null,
        min: def.minLength?.value ?? null,
        max: def.maxLength?.value ?? null
      };

    case 'ZodObject': {
      const shape = def.shape ? def.shape() : {};
      return {
        kind: 'object',
        fields: Object.entries(shape).map(([name, child]) => ({
          name,
          node: introspect(child, depth + 1)
        }))
      };
    }

    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = def.options ?? [];
      if (isColourUnion(options)) return { kind: 'colour' };
      return { kind: 'union', options: options.map((o) => introspect(o, depth + 1)) };
    }

    default:
      return { kind: 'unknown', typeName: def.typeName };
  }
}

/** Top-level convenience: an object schema becomes an ordered field list. */
export function introspectObject(schema: unknown): Array<{ name: string; node: FieldNode }> {
  const node = introspect(schema);
  return node.kind === 'object' ? node.fields : [];
}

/**
 * A sensible starting value when a null field is switched on. Never guesses
 * for a colour: `rgb(0, 0, 0)` is a real colour, `transparent` is not a default.
 */
export function defaultForNode(node: FieldNode): unknown {
  switch (node.kind) {
    case 'string':
      return '';
    case 'number':
      return node.min ?? 0;
    case 'boolean':
      return false;
    case 'enum':
      return node.values[0] ?? '';
    case 'literal':
      return node.value;
    case 'colour':
      return 'rgb(0, 0, 0)';
    case 'nullable':
      return null;
    case 'optional':
      return undefined;
    case 'array':
      return node.exactLength === null
        ? []
        : Array.from({ length: node.exactLength }, () => defaultForNode(node.element));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = defaultForNode(f.node);
      return out;
    }
    case 'union':
      return node.options[0] ? defaultForNode(node.options[0]) : null;
    case 'unknown':
      return null;
  }
}

/** Short type label shown next to each field, so the form is self-documenting. */
export function describeNode(node: FieldNode): string {
  switch (node.kind) {
    case 'string':
      return node.pattern ? 'string (pattern)' : 'string';
    case 'number':
      return node.int ? 'int' : 'number';
    case 'boolean':
      return 'bool';
    case 'enum':
      return `enum(${node.values.length})`;
    case 'literal':
      return `"${String(node.value)}"`;
    case 'colour':
      return 'colour';
    case 'nullable':
      return `${describeNode(node.inner)}?`;
    case 'optional':
      return `${describeNode(node.inner)}?`;
    case 'array':
      return node.exactLength !== null
        ? `${describeNode(node.element)}[${node.exactLength}]`
        : `${describeNode(node.element)}[]`;
    case 'object':
      return `{${node.fields.length}}`;
    case 'union':
      return node.options.map(describeNode).join(' | ');
    case 'unknown':
      return node.typeName;
  }
}
