/**
 * Request validation for the shapes that have no contract in
 * `@rsc-editor/schema`.
 *
 * Anything that crosses the wire between the server and the editor -- ops,
 * sector coordinates, definitions, the WS protocol -- is validated with the Zod
 * schemas from that package and must NOT be restated here. What is left is
 * purely local API plumbing: a project's name, a role string, a query
 * parameter. That is what these helpers cover.
 */

import { badRequest } from './errors.js';

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('expected a JSON object body');
  }
  return body as Record<string, unknown>;
}

export interface StringOptions {
  min?: number;
  max?: number;
}

export function requiredString(
  source: Record<string, unknown>,
  key: string,
  options: StringOptions = {}
): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw badRequest(`${key} is required and must be a string`);
  }
  const trimmed = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 200;
  if (trimmed.length < min || trimmed.length > max) {
    throw badRequest(`${key} must be between ${min} and ${max} characters`);
  }
  return trimmed;
}

export function optionalString(
  source: Record<string, unknown>,
  key: string,
  options: StringOptions = {}
): string | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') return null;
  return requiredString(source, key, { min: 0, ...options });
}

export function optionalInteger(
  value: unknown,
  name: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function requiredInteger(
  value: unknown,
  name: string,
  min: number,
  max: number
): number {
  const n = optionalInteger(value, name, min, max);
  if (n === undefined) throw badRequest(`${name} is required`);
  return n;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requiredUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw badRequest(`${name} must be a uuid`);
  }
  return value;
}

/**
 * A Zod failure from a `@rsc-editor/schema` parse.
 *
 * Detected by shape rather than `instanceof`, because `zod` is not a direct
 * dependency of this app -- importing it here would resolve to a different copy
 * under pnpm's isolated node_modules even if it did resolve at all.
 */
export interface ZodLikeError extends Error {
  issues: Array<{ path: Array<string | number>; message: string }>;
}

export function isZodError(err: unknown): err is ZodLikeError {
  return (
    err instanceof Error &&
    err.name === 'ZodError' &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

export function formatZodIssues(err: ZodLikeError): string[] {
  return err.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
