import {
  ArgumentsHost,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { snakeCase } from 'lodash';
import pinoms from 'pino-multi-stream';
import { Logger } from './logger';

export type ContextValue = Record<string, number | boolean | string>;

export class Context {
  logger: pinoms.Logger;
  private _values: Record<string, string> = {};

  constructor(ctx?: ContextValue) {
    this.logger = Logger.get();
    if (ctx) {
      this.merge(ctx);
    }
  }

  merge(ctx: ContextValue) {
    Object.entries(ctx).forEach(([p, v]) => {
      this._values[snakeCase(p)] = String(v);
    });

    if (this.logger) {
      this.logger = this.logger.child({ ctx: this.values() });
    }
  }

  values() {
    return this._values;
  }

  child(ctx?: ContextValue): Context {
    const newContext = new Context({ ...this.values(), ...ctx });
    newContext.logger = this.logger.child({ ctx: newContext.values() });
    return newContext;
  }
}

export const RequestContext = createParamDecorator(
  (data: unknown, context: ExecutionContext) => extractContext(context),
);

export function extractContext(
  context: ExecutionContext | ArgumentsHost,
): Context | undefined {
  if (context.getType() === 'http') {
    return context.switchToHttp().getRequest().ctx;
  }
  return undefined;
}
