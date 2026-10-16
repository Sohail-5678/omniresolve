/**
 * Typed errors shared by the mock services, the saga and the API layer.
 * ServiceError mirrors an HTTP failure from an upstream API so retry rules can
 * decide on status codes the way they would against a real system.
 */

export type ServiceErrorCode =
  | "UNAVAILABLE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID"
  | "UPSTREAM_SCHEMA_MISMATCH"
  | "OUT_OF_STOCK";

export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ServiceErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
    public readonly faultInjected = false,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** Thrown on purpose by the `crash_after` fault to simulate the process dying mid-saga. */
export class SimulatedCrash extends Error {
  constructor(public readonly afterStep: string) {
    super(`Simulated crash after ${afterStep}`);
    this.name = "SimulatedCrash";
  }
}

export type GuardCode =
  | "TOKEN_MISSING"
  | "TOKEN_BAD_SIGNATURE"
  | "TOKEN_EXPIRED"
  | "TOKEN_ALREADY_USED"
  | "TOKEN_SCOPE_MISMATCH"
  | "TOKEN_AMOUNT_MISMATCH"
  | "TOKEN_REVOKED";

export class GuardError extends Error {
  constructor(public readonly code: GuardCode, message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "HttpError";
  }
}
