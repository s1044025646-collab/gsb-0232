// 加权不放回抽取，算法版本 ALGO_VERSION。
// 规则：
// 1. 候选人先按编号（personId）字典序排序，输入行序不影响结果。
// 2. 每轮在剩余候选人的累计权重区间 [0,total) 上取一个均匀样本，
//    命中区间对应者被选中并从后续轮次移除。
// 3. 重复直到所有人排出顺序；前 slots 名为获选者，其余为候补。

import { rngFromSeed } from "./rng";

export const ALGO_VERSION = "weighted-wr-v1";

export interface Candidate {
  personId: string;
  weight: number;
}

export interface DrawInput {
  seed: string;
  slots: number;
  candidates: Candidate[];
}

export interface DrawResult {
  algoVersion: string;
  /** 完整顺序：先获选者后候补，position 从 1 开始 */
  order: string[];
}

export function drawWeightedWithoutReplacement(input: DrawInput): DrawResult {
  const remaining = input.candidates
    .map((c) => ({ personId: c.personId, weight: c.weight }))
    .sort((a, b) => (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));

  const rng = rngFromSeed(`${ALGO_VERSION}|${input.seed}`);
  const order: string[] = [];

  while (remaining.length > 0) {
    let total = 0;
    for (const c of remaining) total += c.weight;
    const x = Math.floor(rng() * total);
    let acc = 0;
    let hit = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      acc += remaining[i]!.weight;
      if (x < acc) { hit = i; break; }
    }
    order.push(remaining[hit]!.personId);
    remaining.splice(hit, 1);
  }

  return { algoVersion: ALGO_VERSION, order };
}
