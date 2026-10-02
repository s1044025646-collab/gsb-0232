import type { DatabaseSync } from 'node:sqlite';
import { ALGO_VERSION, weightedDraw, type Candidate } from './draw.ts';
import { Errors } from './errors.ts';

export const DEFAULT_MAX_CANDIDATES = 10000;
export const DEFAULT_MAX_WEIGHT = 10000;

interface EventRow {
  id: number;
  name: string;
  quota: number;
  seed: number;
  algo_version: string;
  max_candidates: number;
  max_weight: number;
}

interface RosterRow {
  id: number;
  event_id: number;
  version_no: number;
  frozen: number;
  snapshot_json: string;
}

function getEvent(db: DatabaseSync, eventId: number): EventRow {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as
    | EventRow
    | undefined;
  if (!row) throw Errors.eventNotFound(eventId);
  return row;
}

export function createEvent(
  db: DatabaseSync,
  input: {
    name: string;
    quota: number;
    seed: number;
    maxCandidates?: number;
    maxWeight?: number;
  },
) {
  if (!input.name || typeof input.name !== 'string') {
    throw Errors.invalidInput('name 必须是非空字符串');
  }
  if (!Number.isInteger(input.quota) || input.quota < 1) {
    throw Errors.invalidInput('quota 必须是 >= 1 的整数');
  }
  if (!Number.isInteger(input.seed)) {
    throw Errors.invalidInput('seed 必须是整数');
  }
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const maxWeight = input.maxWeight ?? DEFAULT_MAX_WEIGHT;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw Errors.invalidInput('maxCandidates 必须是 >= 1 的整数');
  }
  if (!Number.isInteger(maxWeight) || maxWeight < 1) {
    throw Errors.invalidInput('maxWeight 必须是 >= 1 的整数');
  }
  const r = db
    .prepare(
      'INSERT INTO events (name, quota, seed, algo_version, max_candidates, max_weight) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(input.name, input.quota, input.seed, ALGO_VERSION, maxCandidates, maxWeight);
  return getEvent(db, Number(r.lastInsertRowid));
}

export function validateCandidates(
  raw: unknown,
  maxCandidates: number,
  maxWeight: number,
): Candidate[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw Errors.invalidInput('candidates 必须是非空数组');
  }
  if (raw.length > maxCandidates) {
    throw Errors.tooManyCandidates(raw.length, maxCandidates);
  }
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const item of raw) {
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || c.id.trim() === '') {
      throw Errors.invalidInput('每名候选人必须包含非空字符串 id');
    }
    if (typeof c.name !== 'string' || c.name.trim() === '') {
      throw Errors.invalidInput(`候选人 ${c.id} 缺少有效 name`);
    }
    if (
      typeof c.weight !== 'number' ||
      !Number.isInteger(c.weight) ||
      c.weight < 1
    ) {
      throw Errors.invalidWeight(
        `候选人 ${c.id} 的权重必须是 >= 1 的整数，收到: ${JSON.stringify(c.weight)}`,
      );
    }
    if (c.weight > maxWeight) {
      throw Errors.invalidWeight(`候选人 ${c.id} 的权重 ${c.weight} 超过上限 ${maxWeight}`);
    }
    if (seen.has(c.id)) {
      throw Errors.duplicateCandidateId(c.id);
    }
    seen.add(c.id);
    out.push({ id: c.id, name: c.name, weight: c.weight });
  }
  return out;
}

// 导入名单 = 产生一个新的（未冻结）名单版本。冻结后不可再改。
export function importRoster(db: DatabaseSync, eventId: number, rawCandidates: unknown) {
  const event = getEvent(db, eventId);
  const candidates = validateCandidates(rawCandidates, event.max_candidates, event.max_weight);
  if (event.quota > candidates.length) {
    throw Errors.quotaExceedsCandidates(event.quota, candidates.length);
  }
  const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tx = db.prepare(
    'SELECT COALESCE(MAX(version_no), 0) + 1 AS v FROM roster_versions WHERE event_id = ?',
  );
  const versionNo = (tx.get(eventId) as { v: number }).v;
  const r = db
    .prepare('INSERT INTO roster_versions (event_id, version_no, frozen, snapshot_json) VALUES (?, ?, 0, ?)')
    .run(eventId, versionNo, JSON.stringify(sorted));
  return { id: Number(r.lastInsertRowid), eventId, versionNo, frozen: false, count: sorted.length };
}

export function freezeRoster(db: DatabaseSync, eventId: number, versionNo: number) {
  getEvent(db, eventId);
  const row = db
    .prepare('SELECT * FROM roster_versions WHERE event_id = ? AND version_no = ?')
    .get(eventId, versionNo) as RosterRow | undefined;
  if (!row) throw Errors.rosterNotFound(`活动 ${eventId} 不存在名单版本 ${versionNo}`);
  if (row.frozen === 1) throw Errors.rosterAlreadyFrozen(versionNo);
  db.prepare('UPDATE roster_versions SET frozen = 1 WHERE id = ?').run(row.id);
  return { eventId, versionNo, frozen: true };
}

function latestFrozenRoster(db: DatabaseSync, eventId: number): RosterRow {
  const row = db
    .prepare(
      'SELECT * FROM roster_versions WHERE event_id = ? AND frozen = 1 ORDER BY version_no DESC LIMIT 1',
    )
    .get(eventId) as RosterRow | undefined;
  if (!row) {
    const anyRow = db
      .prepare('SELECT version_no FROM roster_versions WHERE event_id = ? ORDER BY version_no DESC LIMIT 1')
      .get(eventId) as { version_no: number } | undefined;
    if (anyRow) throw Errors.rosterNotFrozen(anyRow.version_no);
    throw Errors.rosterNotFound(`活动 ${eventId} 尚未导入名单`);
  }
  return row;
}

function getRoster(db: DatabaseSync, eventId: number, versionNo: number): RosterRow {
  const row = db
    .prepare('SELECT * FROM roster_versions WHERE event_id = ? AND version_no = ?')
    .get(eventId, versionNo) as RosterRow | undefined;
  if (!row) throw Errors.rosterNotFound(`活动 ${eventId} 不存在名单版本 ${versionNo}`);
  return row;
}

interface BatchRow {
  id: number;
  event_id: number;
  roster_version_id: number;
  seed: number;
  algo_version: string;
  quota: number;
}

function batchResult(db: DatabaseSync, batch: BatchRow, reused: boolean) {
  const entries = db
    .prepare('SELECT * FROM draw_entries WHERE batch_id = ? ORDER BY position')
    .all(batch.id) as unknown as Array<{
    position: number;
    candidate_id: string;
    candidate_name: string;
    weight: number;
    kind: string;
  }>;
  return {
    batchId: batch.id,
    eventId: batch.event_id,
    rosterVersionId: batch.roster_version_id,
    seed: batch.seed,
    algoVersion: batch.algo_version,
    quota: batch.quota,
    reused,
    order: entries.map((e) => ({
      position: e.position,
      candidateId: e.candidate_id,
      name: e.candidate_name,
      weight: e.weight,
      kind: e.kind,
    })),
  };
}

// 确认抽签：同一 (活动, 名单版本, 种子) 只抽一次，重复确认返回既有结果。
export function confirmDraw(db: DatabaseSync, eventId: number, versionNo?: number) {
  const event = getEvent(db, eventId);
  const roster = versionNo === undefined ? latestFrozenRoster(db, eventId) : getRoster(db, eventId, versionNo);
  if (roster.frozen !== 1) throw Errors.rosterNotFrozen(roster.version_no);

  const existing = db
    .prepare('SELECT * FROM draw_batches WHERE event_id = ? AND roster_version_id = ? AND seed = ?')
    .get(eventId, roster.id, event.seed) as BatchRow | undefined;
  if (existing) return batchResult(db, existing, true);

  const candidates = JSON.parse(roster.snapshot_json) as Candidate[];
  if (event.quota > candidates.length) {
    throw Errors.quotaExceedsCandidates(event.quota, candidates.length);
  }
  const order = weightedDraw(candidates, event.seed);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  db.exec('BEGIN');
  try {
    const r = db
      .prepare(
        'INSERT INTO draw_batches (event_id, roster_version_id, seed, algo_version, quota) VALUES (?, ?, ?, ?, ?)',
      )
      .run(eventId, roster.id, event.seed, ALGO_VERSION, event.quota);
    const batchId = Number(r.lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO draw_entries (batch_id, position, candidate_id, candidate_name, weight, kind) VALUES (?, ?, ?, ?, ?, ?)',
    );
    order.forEach((cid, i) => {
      const c = byId.get(cid)!;
      ins.run(batchId, i + 1, c.id, c.name, c.weight, i < event.quota ? 'winner' : 'waitlist');
    });
    db.exec('COMMIT');
    const batch = db.prepare('SELECT * FROM draw_batches WHERE id = ?').get(batchId) as unknown as BatchRow;
    return batchResult(db, batch, false);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function latestBatch(db: DatabaseSync, eventId: number): BatchRow {
  const row = db
    .prepare('SELECT * FROM draw_batches WHERE event_id = ? ORDER BY id DESC LIMIT 1')
    .get(eventId) as BatchRow | undefined;
  if (!row) throw Errors.drawNotFound(`活动 ${eventId} 尚未确认抽签`);
  return row;
}

// 登记弃权并立即按候补顺序递补（同一事务）。重复弃权幂等，不多占名额。
export function forfeit(db: DatabaseSync, eventId: number, candidateId: string) {
  getEvent(db, eventId);
  const batch = latestBatch(db, eventId);

  const winner = db
    .prepare(
      "SELECT * FROM draw_entries WHERE batch_id = ? AND candidate_id = ? AND kind = 'winner'",
    )
    .get(batch.id, candidateId) as { candidate_id: string } | undefined;
  if (!winner) throw Errors.candidateNotWinner(candidateId);

  const existingForfeit = db
    .prepare('SELECT id FROM forfeits WHERE batch_id = ? AND candidate_id = ?')
    .get(batch.id, candidateId) as { id: number } | undefined;
  if (existingForfeit) {
    return { eventId, batchId: batch.id, candidateId, forfeited: true, already: true, promoted: null };
  }

  db.exec('BEGIN');
  try {
    const fr = db
      .prepare('INSERT INTO forfeits (batch_id, candidate_id) VALUES (?, ?)')
      .run(batch.id, candidateId);
    const forfeitId = Number(fr.lastInsertRowid);

    // 下一位候补 = 候补序列中尚未被递补的第一人
    const next = db
      .prepare(
        `SELECT e.candidate_id, e.candidate_name FROM draw_entries e
         WHERE e.batch_id = ? AND e.kind = 'waitlist'
           AND NOT EXISTS (SELECT 1 FROM promotions p WHERE p.batch_id = e.batch_id AND p.candidate_id = e.candidate_id)
         ORDER BY e.position LIMIT 1`,
      )
      .get(batch.id) as { candidate_id: string; candidate_name: string } | undefined;

    let promoted: { candidateId: string; name: string } | null = null;
    if (next) {
      db.prepare(
        "INSERT INTO promotions (batch_id, forfeit_id, candidate_id, note) VALUES (?, ?, ?, 'promoted')",
      ).run(batch.id, forfeitId, next.candidate_id);
      promoted = { candidateId: next.candidate_id, name: next.candidate_name };
    } else {
      db.prepare(
        "INSERT INTO promotions (batch_id, forfeit_id, candidate_id, note) VALUES (?, ?, NULL, 'vacant')",
      ).run(batch.id, forfeitId);
    }
    db.exec('COMMIT');
    return { eventId, batchId: batch.id, candidateId, forfeited: true, already: false, promoted };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 查询当前名额状态：原始顺序 + 当前获选/候补/弃权/空缺。
export function getResult(db: DatabaseSync, eventId: number) {
  const event = getEvent(db, eventId);
  const batch = latestBatch(db, eventId);
  const base = batchResult(db, batch, false);
  const forfeits = db
    .prepare('SELECT candidate_id, created_at FROM forfeits WHERE batch_id = ? ORDER BY id')
    .all(batch.id) as unknown as Array<{ candidate_id: string; created_at: string }>;
  const promotions = db
    .prepare('SELECT candidate_id, note, created_at FROM promotions WHERE batch_id = ? ORDER BY id')
    .all(batch.id) as unknown as Array<{
    candidate_id: string | null;
    note: string;
    created_at: string;
  }>;

  const forfeitedSet = new Set(forfeits.map((f) => f.candidate_id));
  const promotedList = promotions.filter((p) => p.candidate_id !== null);
  const promotedSet = new Set(promotedList.map((p) => p.candidate_id));
  const vacancies = promotions.filter((p) => p.note === 'vacant').length;

  const currentWinners = base.order
    .filter((e) => e.kind === 'winner' && !forfeitedSet.has(e.candidateId))
    .map((e) => e.candidateId)
    .concat(promotedList.map((p) => p.candidate_id as string));
  const currentWaitlist = base.order
    .filter((e) => e.kind === 'waitlist' && !promotedSet.has(e.candidateId))
    .map((e) => e.candidateId);

  return {
    ...base,
    eventName: event.name,
    forfeits: forfeits.map((f) => f.candidate_id),
    promotions: promotions.map((p) => ({ candidateId: p.candidate_id, note: p.note })),
    vacancies,
    currentWinners,
    currentWaitlist,
  };
}
