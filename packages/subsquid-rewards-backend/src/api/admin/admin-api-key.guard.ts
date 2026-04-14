import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const configuredKey =
      this.configService.get<string>('admin.apiKey') ||
      process.env.ADMIN_API_KEY;

    if (!configuredKey) {
      throw new UnauthorizedException(
        'Admin API is disabled until ADMIN_API_KEY is configured.',
      );
    }

    const headerKey =
      request.headers['x-admin-key'] ||
      request.headers['X-Admin-Key'] ||
      '';
    const authHeader = request.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : '';

    const presentedKey =
      typeof headerKey === 'string'
        ? headerKey
        : Array.isArray(headerKey)
          ? headerKey[0]
          : '';

    if (presentedKey === configuredKey || bearerToken === configuredKey) {
      return true;
    }

    throw new UnauthorizedException('Invalid admin credentials.');
  }
}
