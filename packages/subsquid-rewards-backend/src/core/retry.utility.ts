import { TaskContext } from '../common';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  factor?: number;
  onRetry?: (attempt: number, error: Error) => void;
  context?: TaskContext;
}


export class RetryUtility {
  static async execute<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {},
  ): Promise<T> {
    const {
      maxAttempts = 3, // Same as MAX_RETRIES 
      initialDelay = 1000,
      maxDelay = 10000,
      factor = 2,
      onRetry,
      context,
    } = options;

    let lastError: Error;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;


        if (context) {
          context.logger.warn(
            `Attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`,
          );
        }

        if (attempt === maxAttempts) {
          if (context) {
            context.logger.error(
              { error: lastError },
              `All ${maxAttempts} attempts failed`,
            );
          }
          throw error;
        }

        const delay = Math.min(
          initialDelay * Math.pow(factor, attempt - 1),
          maxDelay,
        );

        onRetry?.(attempt, lastError);

        if (context) {
          context.logger.debug(`Retrying in ${delay}ms...`);
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }

  static async simpleRetry<T>(
    operation: () => Promise<T>,
    maxAttempts: number = 3,
    delay: number = 2000,
  ): Promise<T> {
    return RetryUtility.execute(operation, {
      maxAttempts,
      initialDelay: delay,
      maxDelay: delay,
      factor: 1,
    });
  }
}
