export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "DUPLICATE_PERSON"
  | "INVALID_WEIGHT"
  | "ROSTER_TOO_LARGE"
  | "SLOTS_EXCEED_ROSTER"
  | "NO_ROSTER"
  | "NOT_WINNER"
  | "CONFLICT";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number = 400,
  ) {
    super(message);
  }
}

export const MAX_ROSTER_SIZE = 5000;
export const MAX_WEIGHT = 10000;
