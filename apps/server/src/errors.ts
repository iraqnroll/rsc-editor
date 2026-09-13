/**
 * HTTP errors.
 *
 * Fastify's default error handler honours `statusCode` on a thrown error, so
 * routes can `throw notFound()` instead of threading a reply through every
 * branch.
 */

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    /** stable machine-readable code for the client to switch on. */
    public readonly code: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message = 'bad request', code = 'bad_request') =>
  new HttpError(400, message, code);

export const unauthorized = (message = 'not signed in') =>
  new HttpError(401, message, 'unauthorized');

export const forbidden = (message = 'insufficient permissions') =>
  new HttpError(403, message, 'forbidden');

/**
 * Also the response for "you are not a member of this project".
 *
 * Deliberate: answering 403 there would let anyone enumerate which project ids
 * exist. A non-member and a non-existent project are indistinguishable.
 */
export const notFound = (message = 'not found') =>
  new HttpError(404, message, 'not_found');

export const conflict = (message: string, code = 'conflict') =>
  new HttpError(409, message, code);

export const unprocessable = (message: string, code = 'unprocessable') =>
  new HttpError(422, message, code);

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}
