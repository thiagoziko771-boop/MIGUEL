import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * O Express 4 não encaminha rejeições de handlers async para o middleware de
 * erro — sem este wrapper, uma exceção viraria unhandled rejection e a
 * requisição ficaria pendurada até o timeout do cliente.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
