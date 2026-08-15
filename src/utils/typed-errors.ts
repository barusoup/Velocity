/**
 * Typed errors for the frontend API layer.
 * Replaces the previous `Result<T, String>` from Rust with structured
 * errors that the UI can branch on (retryable vs fatal, display message).
 */

export type ApiErrorKind =
  | "network"
  | "timeout"
  | "not_found"
  | "rate_limited"
  | "forbidden"
  | "offline"
  | "cancelled"
  | "invalid_input"
  | "unknown";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly cause?: unknown;

  constructor(
    kind: ApiErrorKind,
    message: string,
    opts: { retryable?: boolean; statusCode?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.retryable = opts.retryable ?? isRetryableKind(kind);
    this.statusCode = opts.statusCode;
    this.cause = opts.cause;
  }

  static network(message: string, cause?: unknown): ApiError {
    return new ApiError("network", message, { retryable: true, cause });
  }
  static timeout(message = "Request timed out. Try again.", cause?: unknown): ApiError {
    return new ApiError("timeout", message, { retryable: true, cause });
  }
  static notFound(message: string, cause?: unknown): ApiError {
    return new ApiError("not_found", message, { retryable: false, cause });
  }
  static fromUnknown(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    const msg = error instanceof Error ? error.message : String(error ?? "");
    const lower = msg.toLowerCase();
    if (lower.includes("timed out") || lower.includes("timeout")) return ApiError.timeout(msg, error);
    if (lower.includes("network") || lower.includes("failed to fetch") || lower.includes("load failed"))
      return ApiError.network(msg || "Network error. Check your connection.", error);
    if (lower.includes("not found") || lower.includes("404")) return ApiError.notFound(msg, error);
    if (lower.includes("rate") || lower.includes("429") || lower.includes("too many"))
      return new ApiError("rate_limited", msg || "Too many requests. Wait a moment and try again.", {
        retryable: true,
        cause: error,
      });
    if (lower.includes("cancel")) return new ApiError("cancelled", msg, { retryable: false, cause: error });
    return new ApiError("unknown", msg || "Something went wrong.", { retryable: false, cause: error });
  }
}

function isRetryableKind(kind: ApiErrorKind): boolean {
  return kind === "network" || kind === "timeout" || kind === "rate_limited" || kind === "offline";
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof ApiError) return error.retryable;
  if (error instanceof Error) return ApiError.fromUnknown(error).retryable;
  return false;
}

/**
 * Wrap a promise with a timeout. Rejects with ApiError timeout.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(ApiError.timeout(message ?? `Operation timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Invoke a Tauri command with consistent error mapping and optional timeout.
 * Extracts the string error from Rust (`Result<T, String>`) and converts to ApiError.
 */
export async function invokeWithErrorMapping<T>(
  invokeFn: () => Promise<T>,
  opts: { timeoutMs?: number; timeoutMessage?: string } = {},
): Promise<T> {
  try {
    const p = invokeFn();
    const result = opts.timeoutMs ? await withTimeout(p, opts.timeoutMs, opts.timeoutMessage) : await p;
    return result;
  } catch (error) {
    throw ApiError.fromUnknown(error);
  }
}
