import { HttpException, HttpStatus } from '@nestjs/common';
import { TaskContext } from '../common';

/**
 * base controller class that provides common error handling.
 * Maintains exact same API response format as original controllers.
 */
export abstract class BaseController {
  protected async handleRequest<T>(
    handler: () => Promise<T>,
  ): Promise<{ success: boolean; error?: string } & T> {
    try {
      const result = await handler();
      return {
        success: true,
        ...result,
      } as any;
    } catch (error) {
      const errorMessage = error?.message || String(error);

      new TaskContext('error-handling').logger.error(
        { error },
        `Request failed: ${errorMessage}`,
      );

      return {
        success: false,
        error: errorMessage,
      } as any;
    }
  }

  /**
   * Validates required parameters.
   * Throws HttpException with same format as original validation.
   */
  protected validateParams(
    params: Record<string, any>,
    required: string[],
  ): void {
    for (const param of required) {
      if (params[param] === undefined || params[param] === null) {
        throw new HttpException(
          `Missing required parameter: ${param}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
  }

  /**
   * Validates block range.
   * Uses same validation logic as original admin controller.
   */
  protected validateBlockRange(fromBlock: number, toBlock: number): void {
    if (fromBlock >= toBlock) {
      throw new HttpException(
        'Invalid block range: fromBlock must be less than toBlock',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (fromBlock < 0 || toBlock < 0) {
      throw new HttpException(
        'Invalid block range: blocks must be positive',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
