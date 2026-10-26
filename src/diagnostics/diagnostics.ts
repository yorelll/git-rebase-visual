import { FileLogger } from "./fileLogger";

/**
 * Process-wide diagnostics sink. Logging is optional by design: the extension
 * stays fully functional when the file logger is disabled (read-only temp dir,
 * disk full) or when no host has installed a logger yet.
 */
let logger: FileLogger | undefined;

export function setDiagnosticsLogger(value: FileLogger | undefined): void {
  logger = value;
}

export function diagnosticsLogger(): FileLogger | undefined {
  return logger;
}

/** Appends an info-level diagnostic to the session file, if one is active. */
export function logDiagnostic(operation: string, message: string): void {
  logger?.info(operation, message);
}

/** Appends a warning-level diagnostic to the session file, if active. */
export function warnDiagnostic(operation: string, message: string): void {
  logger?.warn(operation, message);
}

/** Appends an error plus its stack trace to the session file, if active. */
export function errorDiagnostic(operation: string, message: string, error?: unknown): void {
  logger?.error(operation, message, error);
}
