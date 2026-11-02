import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ApiError } from '../../../shared/api-types';
import { EngineError } from '../engine/errors';

/** An error with an explicit HTTP status; `code` and `message` become the ApiError body. */
export class ApiHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiHttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const unauthorized = () => new ApiHttpError(401, 'unauthorized', '로그인이 필요합니다.');
export const forbidden = (message = '권한이 없습니다.') => new ApiHttpError(403, 'forbidden', message);
export const notFound = (message = '찾을 수 없습니다.') => new ApiHttpError(404, 'not_found', message);
export const badRequest = (code: string, message: string) => new ApiHttpError(400, code, message);

const HANGUL = /[가-힣]/;

/** Korean message for the first issue: the schema's own Korean message, or a generic one naming the field. */
function validationMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return '입력값이 올바르지 않습니다.';
  if (HANGUL.test(issue.message)) return issue.message;
  const field = issue.path.map(String).join('.');
  return field ? `입력값이 올바르지 않습니다: ${field}` : '입력값이 올바르지 않습니다.';
}

function send(reply: FastifyReply, status: number, error: string, message: string): FastifyReply {
  const body: ApiError = { error, message };
  return reply.code(status).type('application/json; charset=utf-8').send(body);
}

/** Maps every thrown error to an ApiError body. Stack traces are only logged, never sent. */
export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (err instanceof ApiHttpError) return send(reply, err.statusCode, err.code, err.message);
  if (err instanceof EngineError) return send(reply, err.code === 'not_found' ? 404 : 400, err.code, err.message);
  if (err instanceof ZodError) return send(reply, 400, 'validation', validationMessage(err));

  const status = (err as FastifyError).statusCode;
  if (status === 429) return send(reply, 429, 'rate_limited', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return send(reply, status, 'bad_request', '요청 형식이 올바르지 않습니다.');
  }
  req.log.error({ err }, 'unhandled error');
  return send(reply, 500, 'internal', '서버 오류가 발생했습니다.');
}
