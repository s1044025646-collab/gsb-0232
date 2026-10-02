import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { weightedDraw, ALGO_VERSION, type Candidate } from '../src/draw.ts';
import {
  confirmDraw,
  createEvent,
  forfeit,
  freezeRoster,
  getResult,
  importRoster,
} from '../src/service.ts';

const ROSTER: Candidate[] = [
  { id: 'C001', name: '甲', weight: 1 },
  { id: 'C002', name: '乙', weight: 2 },
  { id: 'C003', name: '丙', weight: 1 },
  { id: 'C004', name: '丁', weight: 3 },
  { id: 'C005', name: '戊', weight: 1 },
  { id: 'C006', name: '己', weight: 2 },
];

let dir: string;
let db: DatabaseSync;
let dbCounter = 0;
const openDbs: DatabaseSync[] = [];

function freshDb(): DatabaseSync {
  dbCounter++;
  const d = openDb(path.join(dir, `t${dbCounter}.db`));
  openDbs.push(d);
  return d;
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-test-'));
  db = freshDb();
});

after(() => {
  for (const d of openDbs) {
    try {
      d.close();
    } catch {}
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('固定种子产生预先确定的顺序（可复现）', () => {
  const order = weightedDraw(ROSTER, 42);
  assert.deepEqual(order, ['C004', 'C003', 'C006', 'C002', 'C001', 'C005']);
  // 再跑两次仍一致
  assert.deepEqual(weightedDraw(ROSTER, 42), order);
  assert.deepEqual(weightedDraw(ROSTER, 42), order);
  // 不同种子是独立结果
  assert.deepEqual(weightedDraw(ROSTER, 7), ['C001', 'C002', 'C006', 'C004', 'C005', 'C003']);
});

test('抽取结果无重复人员且覆盖全员', () => {
  const order = weightedDraw(ROSTER, 42);
  assert.equal(new Set(order).size, ROSTER.length);
  assert.deepEqual([...order].sort(), ROSTER.map((c) => c.id).sort());
});

test('输入行序不影响结果', () => {
  const reversed = [...ROSTER].reverse();
  const shuffled = [ROSTER[3], ROSTER[0], ROSTER[5], ROSTER[2], ROSTER[4], ROSTER[1]];
  const expected = weightedDraw(ROSTER, 42);
  assert.deepEqual(weightedDraw(reversed, 42), expected);
  assert.deepEqual(weightedDraw(shuffled, 42), expected);
});

test('权重差异效果可复现：高权重者显著更常先被抽中', () => {
  const w: Candidate[] = [
    { id: 'A', name: '甲', weight: 1 },
    { id: 'B', name: '乙', weight: 1 },
    { id: 'C', name: '丙', weight: 1 },
    { id: 'D', name: '丁', weight: 30 },
  ];
  let dFirst = 0;
  for (let s = 1; s <= 40; s++) {
    if (weightedDraw(w, s)[0] === 'D') dFirst++;
  }
  assert.equal(dFirst, 36); // 期望约 30/33 ≈ 91%
});

test('零权重与非法权重被拒绝', () => {
  const db1 = freshDb();
  const ev = createEvent(db1, { name: 'e', quota: 1, seed: 1 });
  assert.throws(
    () => importRoster(db1, ev.id, [{ id: 'A', name: 'a', weight: 0 }]),
    /INVALID_WEIGHT|权重/,
  );
  assert.throws(
    () => importRoster(db1, ev.id, [{ id: 'A', name: 'a', weight: -3 }]),
    /权重/,
  );
  assert.throws(
    () => importRoster(db1, ev.id, [{ id: 'A', name: 'a', weight: 1.5 }]),
    /权重/,
  );
  assert.throws(
    () => importRoster(db1, ev.id, [{ id: 'A', name: 'a', weight: 'x' }]),
    /权重/,
  );
});

test('权重超过上限被拒绝', () => {
  const db1 = freshDb();
  const ev = createEvent(db1, { name: 'e', quota: 1, seed: 1, maxWeight: 10 });
  assert.throws(
    () => importRoster(db1, ev.id, [{ id: 'A', name: 'a', weight: 11 }]),
    /超过上限/,
  );
});

test('重复编号被拒绝', () => {
  const db1 = freshDb();
  const ev = createEvent(db1, { name: 'e', quota: 1, seed: 1 });
  assert.throws(
    () =>
      importRoster(db1, ev.id, [
        { id: 'A', name: 'a', weight: 1 },
        { id: 'A', name: 'b', weight: 1 },
      ]),
    /DUPLICATE_CANDIDATE_ID|重复/,
  );
});

test('名额超出人数被拒绝', () => {
  const db1 = freshDb();
  const ev = createEvent(db1, { name: 'e', quota: 3, seed: 1 });
  assert.throws(
    () =>
      importRoster(db1, ev.id, [
        { id: 'A', name: 'a', weight: 1 },
        { id: 'B', name: 'b', weight: 1 },
      ]),
    /QUOTA_EXCEEDS_CANDIDATES|超过候选人数/,
  );
});

test('全员获选：名额等于人数时没有候补', () => {
  const db1 = freshDb();
  const ev = createEvent(db1, { name: 'e', quota: 2, seed: 5 });
  importRoster(db1, ev.id, [
    { id: 'A', name: 'a', weight: 1 },
    { id: 'B', name: 'b', weight: 1 },
  ]);
  freezeRoster(db1, ev.id, 1);
  const r = confirmDraw(db1, ev.id);
  assert.equal(r.order.filter((o) => o.kind === 'winner').length, 2);
  assert.equal(r.order.filter((o) => o.kind === 'waitlist').length, 0);
});

test('未冻结名单不能抽签；冻结后不可重复冻结；修改名单产生新版本', () => {
  const db1 = freshDb();
  const ev = createEvent(db1, { name: 'e', quota: 1, seed: 1 });
  const v1 = importRoster(db1, ev.id, [
    { id: 'A', name: 'a', weight: 1 },
    { id: 'B', name: 'b', weight: 1 },
  ]);
  assert.throws(() => confirmDraw(db1, ev.id), /ROSTER_NOT_FROZEN|尚未冻结/);
  freezeRoster(db1, ev.id, 1);
  assert.throws(() => freezeRoster(db1, ev.id, 1), /ROSTER_ALREADY_FROZEN|已冻结/);
  const v2 = importRoster(db1, ev.id, [
    { id: 'A', name: 'a', weight: 1 },
    { id: 'B', name: 'b', weight: 1 },
    { id: 'C', name: 'c', weight: 1 },
  ]);
  assert.equal(v1.versionNo, 1);
  assert.equal(v2.versionNo, 2);
  // 旧版本抽签结果不受新版本影响
  const d1 = confirmDraw(db1, ev.id, 1);
  assert.equal(d1.order.length, 2);
});

test('重复确认同一批次返回既有结果，不重新抽', () => {
  const db1 = freshDb();
  const ev = createEvent(db1, { name: 'e', quota: 2, seed: 42 });
  importRoster(db1, ev.id, ROSTER);
  freezeRoster(db1, ev.id, 1);
  const d1 = confirmDraw(db1, ev.id);
  const d2 = confirmDraw(db1, ev.id);
  assert.equal(d1.reused, false);
  assert.equal(d2.reused, true);
  assert.equal(d1.batchId, d2.batchId);
  assert.deepEqual(
    d1.order.map((o) => o.candidateId),
    d2.order.map((o) => o.candidateId),
  );
  const batches = db1.prepare('SELECT COUNT(*) AS n FROM draw_batches').get() as { n: number };
  assert.equal(batches.n, 1);
});

test('弃权后候补按原顺序递补；重复弃权幂等', () => {
  const db1 = freshDb();
  const ev = createEvent(db1, { name: 'e', quota: 2, seed: 42 });
  importRoster(db1, ev.id, ROSTER);
  freezeRoster(db1, ev.id, 1);
  const d = confirmDraw(db1, ev.id);
  // 种子 42 顺序: C004 C003 | C006 C002 C001 C005
  const [w1, w2] = d.order.slice(0, 2).map((o) => o.candidateId);
  const firstWait = d.order[2].candidateId;
  const secondWait = d.order[3].candidateId;

  const f1 = forfeit(db1, ev.id, w1);
  assert.equal(f1.promoted!.candidateId, firstWait);
  const f2 = forfeit(db1, ev.id, w2);
  assert.equal(f2.promoted!.candidateId, secondWait);

  // 重复弃权：幂等，不再产生递补
  const f1again = forfeit(db1, ev.id, w1);
  assert.equal(f1again.already, true);
  const promoCount = db1
    .prepare('SELECT COUNT(*) AS n FROM promotions')
    .get() as { n: number };
  assert.equal(promoCount.n, 2);

  const r = getResult(db1, ev.id);
  assert.deepEqual(r.currentWinners, [firstWait, secondWait]);
  assert.deepEqual(r.forfeits, [w1, w2]);
});

test('候补用尽时记录空缺', () => {
  const db1 = freshDb();
  const ev = createEvent(db1, { name: 'e', quota: 2, seed: 9 });
  importRoster(db1, ev.id, [
    { id: 'A', name: 'a', weight: 1 },
    { id: 'B', name: 'b', weight: 1 },
    { id: 'C', name: 'c', weight: 1 },
  ]);
  freezeRoster(db1, ev.id, 1);
  const d = confirmDraw(db1, ev.id);
  const winners = d.order.slice(0, 2).map((o) => o.candidateId);
  const onlyWait = d.order[2].candidateId;
  const f1 = forfeit(db1, ev.id, winners[0]);
  assert.equal(f1.promoted!.candidateId, onlyWait);
  const f2 = forfeit(db1, ev.id, winners[1]);
  assert.equal(f2.promoted, null); // 候补用尽
  const r = getResult(db1, ev.id);
  assert.equal(r.vacancies, 1);
  assert.equal(r.currentWinners.length, 1);
});

test('非获选者不能登记弃权', () => {
  const db1 = freshDb();
  const ev = createEvent(db1, { name: 'e', quota: 1, seed: 1 });
  importRoster(db1, ev.id, [
    { id: 'A', name: 'a', weight: 1 },
    { id: 'B', name: 'b', weight: 1 },
  ]);
  freezeRoster(db1, ev.id, 1);
  const d = confirmDraw(db1, ev.id);
  const wait = d.order[1].candidateId;
  assert.throws(() => forfeit(db1, ev.id, wait), /CANDIDATE_NOT_WINNER|不是当前获选者/);
});

test('服务重启后可核对原始结果与当前状态', () => {
  const dbPath = path.join(dir, 'restart.db');
  const db1 = openDb(dbPath);
  const ev = createEvent(db1, { name: 'e', quota: 2, seed: 42 });
  importRoster(db1, ev.id, ROSTER);
  freezeRoster(db1, ev.id, 1);
  const d1 = confirmDraw(db1, ev.id);
  forfeit(db1, ev.id, d1.order[0].candidateId);
  db1.close();

  const db2 = openDb(dbPath);
  const r = getResult(db2, ev.id);
  assert.equal(r.algoVersion, ALGO_VERSION);
  assert.deepEqual(
    r.order.map((o) => o.candidateId),
    ['C004', 'C003', 'C006', 'C002', 'C001', 'C005'],
  );
  assert.deepEqual(r.forfeits, ['C004']);
  assert.deepEqual(r.currentWinners, ['C003', 'C006']);
  db2.close();
});
