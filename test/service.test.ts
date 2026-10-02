import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb } from "../src/db";
import { LotteryService } from "../src/service";
import { ApiError } from "../src/errors";

function makeService(slots = 2, seed = "svc-seed") {
  const svc = new LotteryService(openDb(":memory:"));
  const ev = svc.createEvent({ name: "测试活动", slots, seed });
  return { svc, ev };
}

const roster = [
  { personId: "P1", name: "甲", weight: 1 },
  { personId: "P2", name: "乙", weight: 2 },
  { personId: "P3", name: "丙", weight: 3 },
  { personId: "P4", name: "丁", weight: 1 },
];

test("零权重与非法权重报错", () => {
  const { svc, ev } = makeService();
  assert.throws(
    () => svc.importRoster(ev.id, [{ personId: "P1", name: "甲", weight: 0 }]),
    (e: any) => e instanceof ApiError && e.code === "INVALID_WEIGHT",
  );
  assert.throws(
    () => svc.importRoster(ev.id, [{ personId: "P1", name: "甲", weight: 1.5 }]),
    (e: any) => (e as ApiError).code === "INVALID_WEIGHT",
  );
  assert.throws(
    () => svc.importRoster(ev.id, [{ personId: "P1", name: "甲", weight: 10001 }]),
    (e: any) => (e as ApiError).code === "INVALID_WEIGHT",
  );
});

test("重复编号报错", () => {
  const { svc, ev } = makeService();
  assert.throws(
    () =>
      svc.importRoster(ev.id, [
        { personId: "P1", name: "甲", weight: 1 },
        { personId: "P1", name: "乙", weight: 1 },
      ]),
    (e: any) => (e as ApiError).code === "DUPLICATE_PERSON",
  );
});

test("名单冻结为新版本，再次导入产生新版本", () => {
  const { svc, ev } = makeService();
  const v1 = svc.importRoster(ev.id, roster);
  const v2 = svc.importRoster(ev.id, [...roster, { personId: "P5", name: "戊", weight: 1 }]);
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(v1.frozen, true);
  assert.equal(svc.getRoster(ev.id, v1.rosterVersionId).entries.length, 4);
});

test("名额超出人数报错", () => {
  const { svc, ev } = makeService(10);
  svc.importRoster(ev.id, roster);
  assert.throws(() => svc.confirmDraw(ev.id, {}), (e: any) => (e as ApiError).code === "SLOTS_EXCEED_ROSTER");
});

test("确认抽签幂等：重复确认返回既有结果", () => {
  const { svc, ev } = makeService();
  svc.importRoster(ev.id, roster);
  const d1 = svc.confirmDraw(ev.id, {});
  const d2 = svc.confirmDraw(ev.id, {});
  assert.equal(d1.reused, false);
  assert.equal(d2.reused, true);
  assert.equal(d1.batchId, d2.batchId);
  assert.deepEqual(
    d1.originalOrder.map((o: any) => o.personId),
    d2.originalOrder.map((o: any) => o.personId),
  );
});

test("不同种子产生独立批次", () => {
  const { svc, ev } = makeService();
  svc.importRoster(ev.id, roster);
  const d1 = svc.confirmDraw(ev.id, {});
  const d2 = svc.confirmDraw(ev.id, { seed: "another" });
  assert.notEqual(d1.batchId, d2.batchId);
});

test("弃权后候补按最初顺序递补，重复弃权幂等", () => {
  const { svc, ev } = makeService(2);
  svc.importRoster(ev.id, roster);
  const d = svc.confirmDraw(ev.id, {});
  const winners = d.originalOrder.filter((o: any) => o.role === "winner").map((o: any) => o.personId);
  const waitlist = d.originalOrder.filter((o: any) => o.role === "waitlist").map((o: any) => o.personId);
  const r1 = svc.abandon(d.batchId, winners[0]);
  assert.equal(r1.promoted, waitlist[0]);
  const r2 = svc.abandon(d.batchId, winners[0]);
  assert.equal(r2.reused, true);
  const state = svc.getBatchResult(d.batchId);
  assert.equal(state.currentWinners.length, 2);
  assert.ok(state.currentWinners.includes(waitlist[0]));
  assert.ok(!state.currentWinners.includes(winners[0]));
});

test("候补用尽后记录空缺", () => {
  const { svc, ev } = makeService(2);
  svc.importRoster(ev.id, roster.slice(0, 3));
  const d = svc.confirmDraw(ev.id, {});
  const winners = d.originalOrder.filter((o: any) => o.role === "winner").map((o: any) => o.personId);
  svc.abandon(d.batchId, winners[0]);
  const r2 = svc.abandon(d.batchId, winners[1]);
  assert.equal(r2.promoted, null);
  assert.match(r2.note, /空缺/);
  const state = svc.getBatchResult(d.batchId);
  assert.equal(state.vacancies, 1);
  assert.equal(state.currentWinners.length, 1);
});

test("非获选者不能弃权", () => {
  const { svc, ev } = makeService(1);
  svc.importRoster(ev.id, roster);
  const d = svc.confirmDraw(ev.id, {});
  const wait = d.originalOrder.find((o: any) => o.role === "waitlist").personId;
  assert.throws(() => svc.abandon(d.batchId, wait), (e: any) => (e as ApiError).code === "NOT_WINNER");
});

test("全员获选（无候补）", () => {
  const { svc, ev } = makeService(4);
  svc.importRoster(ev.id, roster);
  const d = svc.confirmDraw(ev.id, {});
  assert.equal(d.originalOrder.filter((o: any) => o.role === "winner").length, 4);
});

test("重启后可核对：换连接重开同一数据库结果一致", () => {
  const tmp = path.join(os.tmpdir(), `lottery-test-${Date.now()}.db`);
  try {
    const svc1 = new LotteryService(openDb(tmp));
    const ev = svc1.createEvent({ name: "重启测试", slots: 2, seed: "persist" });
    svc1.importRoster(ev.id, roster);
    const d1 = svc1.confirmDraw(ev.id, {});
    svc1.abandon(d1.batchId, d1.originalOrder[0].personId);

    const svc2 = new LotteryService(openDb(tmp));
    const d2 = svc2.getBatchResult(d1.batchId);
    assert.deepEqual(
      d1.originalOrder.map((o: any) => o.personId),
      d2.originalOrder.map((o: any) => o.personId),
    );
    assert.equal(d2.replacements.length, 1);
    assert.equal(d2.currentWinners.length, 2);
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(tmp + suffix); } catch {}
    }
  }
});
