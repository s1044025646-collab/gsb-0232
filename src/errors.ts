export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const Errors = {
  invalidInput: (msg: string) => new ApiError('INVALID_INPUT', msg, 400),
  invalidWeight: (msg: string) => new ApiError('INVALID_WEIGHT', msg, 400),
  duplicateCandidateId: (id: string) =>
    new ApiError('DUPLICATE_CANDIDATE_ID', `候选人编号重复: ${id}`, 400),
  tooManyCandidates: (n: number, max: number) =>
    new ApiError('TOO_MANY_CANDIDATES', `候选人数 ${n} 超过上限 ${max}`, 400),
  quotaExceedsCandidates: (quota: number, n: number) =>
    new ApiError('QUOTA_EXCEEDS_CANDIDATES', `名额数 ${quota} 超过候选人数 ${n}`, 400),
  eventNotFound: (id: number) => new ApiError('EVENT_NOT_FOUND', `活动不存在: ${id}`, 404),
  rosterNotFound: (msg: string) => new ApiError('ROSTER_NOT_FOUND', msg, 404),
  rosterNotFrozen: (v: number) =>
    new ApiError('ROSTER_NOT_FROZEN', `名单版本 ${v} 尚未冻结，不能用于抽签`, 409),
  rosterAlreadyFrozen: (v: number) =>
    new ApiError('ROSTER_ALREADY_FROZEN', `名单版本 ${v} 已冻结，不能重复冻结`, 409),
  drawNotFound: (msg: string) => new ApiError('DRAW_NOT_FOUND', msg, 404),
  candidateNotWinner: (id: string) =>
    new ApiError('CANDIDATE_NOT_WINNER', `候选人 ${id} 不是当前获选者，无法登记弃权`, 409),
};
