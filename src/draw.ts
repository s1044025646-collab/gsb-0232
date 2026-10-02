import { mulberry32 } from './rng.ts';

export const ALGO_VERSION = 'weighted-swor-v1';

export interface Candidate {
  id: string;
  name: string;
  weight: number;
}

// 加权不放回抽取（weighted sampling without replacement）。
// 算法版本 weighted-swor-v1：
//   1. 候选人先按编号(id)字典序排序，输入行序不影响结果；
//   2. 每轮计算剩余候选人权重总和 total，取 r = rng() * total；
//   3. 按排序后的顺序累计权重，r 落在谁的区间谁被选中；
//   4. 选中者从池中移除，进入下一轮，直到池空。
// 输出为完整顺序：前 quota 名为获选者，其余按顺序为候补。
export function weightedDraw(candidates: Candidate[], seed: number): string[] {
  const pool = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rng = mulberry32(seed);
  const order: string[] = [];
  while (pool.length > 0) {
    let total = 0;
    for (const c of pool) total += c.weight;
    let r = rng() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      if (r < pool[i].weight) {
        idx = i;
        break;
      }
      r -= pool[i].weight;
    }
    order.push(pool[idx].id);
    pool.splice(idx, 1);
  }
  return order;
}
