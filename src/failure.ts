export const EXIT_OK = 0;
export const EXIT_TOOL_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_AUTH_OR_NETWORK = 3;

export type ExitCode = typeof EXIT_OK | typeof EXIT_TOOL_ERROR | typeof EXIT_USAGE | typeof EXIT_AUTH_OR_NETWORK;

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/** A failure the CLI reports as `{code, message, details?}` on stderr, with its exit code. */
export class CliFailure extends Error {
  constructor(
    readonly exitCode: ExitCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  get body(): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function usageFailure(message: string): CliFailure {
  return new CliFailure(EXIT_USAGE, 'USAGE', message);
}
