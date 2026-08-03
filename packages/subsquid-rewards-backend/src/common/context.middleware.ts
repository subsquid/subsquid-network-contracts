import { NextFunction, Request, Response } from 'express';
import { v4 } from 'uuid';
import { Context } from './context';

function newRequestId() {
  return `gen-${v4()}`;
}

export const NGINX_REQUEST_ID = 'x-request-id';
export const CTX_REQ_ID = 'req_id';
export const CTX_REQ_USER_IP = 'req_user_ip';
export const CTX_REQ_USER_AGENT = 'req_user_agent';

export function contextMiddleware(
  req: Request & { ctx: Context },
  res: Response,
  next: NextFunction,
) {
  const requestId = req.header(NGINX_REQUEST_ID) || newRequestId();
  const userIp = req.connection?.remoteAddress || '127.0.0.1';

  req.ctx = new Context({
    [CTX_REQ_ID]: requestId,
    [CTX_REQ_USER_IP]: userIp,
    [CTX_REQ_USER_AGENT]: req.header('user-agent') || '',
    http_path: req.url,
    http_method: req.method,
  });

  res.header('X-Req-Id', requestId);

  next();
}
