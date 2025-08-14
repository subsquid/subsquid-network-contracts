import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaskContext } from '../common';

@Injectable()
export abstract class BaseService {

  protected abstract readonly serviceName: string;

  constructor(protected configService: ConfigService) {}
  protected ctx(operation: string): TaskContext {
    return new TaskContext(`${this.serviceName}:${operation}`);
  }

  protected async withContext<T>(
    operation: string,
    handler: (ctx: TaskContext) => Promise<T>,
  ): Promise<T> {
    const ctx = this.ctx(operation);
    try {
      return await handler(ctx);
    } catch (error) {
      ctx.logger.error({ error }, `${operation} failed`);
      throw error;
    }
  }

  protected config<T = any>(path: string, defaultValue?: T): T {
    return this.configService.get<T>(path, defaultValue as T);
  }

  protected getConfig<T = any>(path: string, defaultValue?: T): T {
    const keys = path.split('.');
    let value: any = this.configService;

    for (const key of keys) {
      value = value?.get ? value.get(key) : value?.[key];
      if (value === undefined) {
        return defaultValue as T;
      }
    }

    return value as T;
  }
}
