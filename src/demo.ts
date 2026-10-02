import fs from 'node:fs';
import path from 'node:path';
import { openDb, DATA_DIR } from './db.ts';
import {
  confirmDraw,
  createEvent,
  forfeit,
  freezeRoster,
  getResult,
  importRoster,
} from './service.ts';
import { weightedDraw, type Candidate } from './draw.ts';

function show(title: string, x: unknown) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(x, null, 2));
}

export function runDemo() {
  const dbPath = path.join(DATA_DIR, 'demo.db');
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  const db = openDb(dbPath);
  const roster = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'sample-roster.json'), 'utf8'),
  ).candidates as Candidate[];

  console.log('演示数据库:', dbPath);
  console.log('名单人数:', roster.length, '（虚构人员）');

  // 1. 固定种子抽签
  const ev = createEvent(db, { name: '2026 春季观影福利（演示）', quota: 4, seed: 42 });
  show('1. 创建活动（名额 4，种子 42）', ev);

  const imp = importRoster(db, ev.id, roster);
  show('2. 导入名单（版本 1）', imp);
  show('3. 冻结名单版本 1', freezeRoster(db, ev.id, 1));

  const draw1 = confirmDraw(db, ev.id);
  show(
    '4. 确认抽签（种子 42）',
    draw1.order.map((o) => `${o.position}. ${o.candidateId} ${o.name} [${o.kind}]`),
  );

  // 2. 重复确认 -> 返回既有结果
  const draw2 = confirmDraw(db, ev.id);
  console.log('\n=== 5. 重复确认同一批次 ===');
  console.log('reused =', draw2.reused, '，batchId 相同 =', draw2.batchId === draw1.batchId);

  // 3. 获选者弃权 -> 候补递补
  const firstWinner = draw1.order[0].candidateId;
  show(`6. 获选者 ${firstWinner} 弃权`, forfeit(db, ev.id, firstWinner));
  const after = getResult(db, ev.id);
  show('7. 当前名额状态', {
    currentWinners: after.currentWinners,
    currentWaitlist: after.currentWaitlist,
    forfeits: after.forfeits,
    promotions: after.promotions,
  });

  // 4. 重复弃权幂等
  show('8. 重复登记同一弃权（幂等）', forfeit(db, ev.id, firstWinner));

  // 5. 另一种子 -> 独立批次
  const ev2 = createEvent(db, { name: '2026 春季观影福利（第二批次，种子 7）', quota: 4, seed: 7 });
  importRoster(db, ev2.id, roster);
  freezeRoster(db, ev2.id, 1);
  const drawB = confirmDraw(db, ev2.id);
  show(
    '9. 另一批次（种子 7，独立结果）',
    drawB.order.map((o) => `${o.position}. ${o.candidateId} ${o.name} [${o.kind}]`),
  );

  // 6. 权重效果的可复现样例
  const weighted: Candidate[] = [
    { id: 'A', name: '甲', weight: 1 },
    { id: 'B', name: '乙', weight: 1 },
    { id: 'C', name: '丙', weight: 1 },
    { id: 'D', name: '丁', weight: 30 },
  ];
  let dFirst = 0;
  const total = 40;
  for (let s = 1; s <= total; s++) {
    if (weightedDraw(weighted, s)[0] === 'D') dFirst++;
  }
  console.log('\n=== 10. 权重效果（可复现） ===');
  console.log(
    `4 名候选人，D 权重 30、其余 1。种子 1..${total} 中 D 首个被抽中 ${dFirst}/${total} 次（期望约 30/33 ≈ 91%）。`,
  );
  console.log('\n演示完成。可用 result 命令复查: node src/cli.ts result --event 1 --db data/demo.db');
}
