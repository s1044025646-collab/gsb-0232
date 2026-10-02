import { test } from "node:test";
import assert from "node:assert/strict";
import { drawWeightedWithoutReplacement } from "../src/draw";

const roster = [
  { personId: "A", weight: 1 },
  { personId: "B", weight: 3 },
  { personId: "C", weight: 2 },
  { personId: "D", weight: 1 },
  { personId: "E", weight: 4 },
];

test("预先确定的种子结果（锁定可复现输出）", () => {
  const r = drawWeightedWithoutReplacement({ seed: "fixed-seed", slots: 2, candidates: roster });
  assert.deepEqual(r.order, ["E", "B", "D", "C", "A"]);
  assert.equal(r.algoVersion, "weighted-wr-v1");
});

test("同种子同结果，不同种子通常不同", () => {
  const r1 = drawWeightedWithoutReplacement({ seed: "s1", slots: 2, candidates: roster });
  const r2 = drawWeightedWithoutReplacement({ seed: "s1", slots: 2, candidates: roster });
  assert.deepEqual(r1, r2);
  const r3 = drawWeightedWithoutReplacement({ seed: "s2", slots: 2, candidates: roster });
  assert.notDeepEqual(r1.order, r3.order);
});

test("无重复人员，顺序覆盖全部候选人", () => {
  const r = drawWeightedWithoutReplacement({ seed: "x", slots: 3, candidates: roster });
  assert.equal(new Set(r.order).size, roster.length);
  assert.deepEqual([...r.order].sort(), roster.map((c) => c.personId).sort());
});

test("输入行序不影响结果", () => {
  const shuffled = [...roster].reverse();
  const r1 = drawWeightedWithoutReplacement({ seed: "order", slots: 2, candidates: roster });
  const r2 = drawWeightedWithoutReplacement({ seed: "order", slots: 2, candidates: shuffled });
  assert.deepEqual(r1.order, r2.order);
});

test("权重差异的可复现体现：高权重者在多种子下更常靠前", () => {
  let heavyFirst = 0;
  const seeds = 50;
  const cands = [
    { personId: "heavy", weight: 100 },
    { personId: "l1", weight: 1 },
    { personId: "l2", weight: 1 },
  ];
  for (let i = 0; i < seeds; i++) {
    const r = drawWeightedWithoutReplacement({ seed: `w-${i}`, slots: 1, candidates: cands });
    if (r.order[0] === "heavy") heavyFirst++;
  }
  assert.ok(heavyFirst > 30, `heavy 首位次数过少: ${heavyFirst}`);
});

test("全员获选（slots 等于人数）", () => {
  const r = drawWeightedWithoutReplacement({ seed: "all", slots: roster.length, candidates: roster });
  assert.equal(r.order.length, roster.length);
});
