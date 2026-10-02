import * as fs from "node:fs";
import { openDb, DEFAULT_DB_PATH } from "./db";
import { LotteryService } from "./service";
import { ApiError } from "./errors";

const dbPath = process.env.LOTTERY_DB ?? DEFAULT_DB_PATH;
const service = new LotteryService(openDb(dbPath));

function out(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const FICTIONAL_ROSTER = [
  { personId: "P001", name: "林晓风", weight: 1 },
  { personId: "P002", name: "陈雨桐", weight: 3 },
  { personId: "P003", name: "赵启明", weight: 1 },
  { personId: "P004", name: "孙可欣", weight: 2 },
  { personId: "P005", name: "周子昂", weight: 1 },
  { personId: "P006", name: "吴梦琪", weight: 5 },
  { personId: "P007", name: "郑浩然", weight: 1 },
  { personId: "P008", name: "王若彤", weight: 2 },
];

function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "create-event":
      out(service.createEvent({
        name: arg("--name") ?? "未命名活动",
        slots: Number(arg("--slots") ?? "1"),
        seed: arg("--seed") ?? "seed-1",
      }));
      break;
    case "import-roster": {
      const file = arg("--file");
      if (!file) throw new ApiError("VALIDATION", "需要 --file <json>");
      const entries = JSON.parse(fs.readFileSync(file, "utf8"));
      out(service.importRoster(Number(arg("--event")), entries));
      break;
    }
    case "draw":
      out(service.confirmDraw(Number(arg("--event")), {
        rosterVersionId: arg("--roster") ? Number(arg("--roster")) : undefined,
        seed: arg("--seed"),
      }));
      break;
    case "result":
      out(service.getBatchResult(Number(arg("--batch"))));
      break;
    case "abandon":
      out(service.abandon(Number(arg("--batch")), String(arg("--person"))));
      break;
    case "event":
      out(service.getEvent(Number(arg("--id"))));
      break;
    case "demo": {
      console.log("== 1. 创建活动（3 个名额，种子 demo-seed）==");
      const ev = service.createEvent({ name: "年终福利抽签(演示)", slots: 3, seed: "demo-seed" });
      out(ev);
      console.log("== 2. 导入虚构名单并冻结为版本 1 ==");
      out(service.importRoster(ev.id, FICTIONAL_ROSTER));
      console.log("== 3. 确认抽签（固定种子）==");
      const d1 = service.confirmDraw(ev.id, {});
      out(d1.originalOrder.map((o: any) => `${o.position}. ${o.personId} ${o.name} [${o.role}]`));
      console.log("== 4. 再次确认（同种子，应复用既有结果）==");
      const d2 = service.confirmDraw(ev.id, {});
      console.log(`reused=${d2.reused}, batchId 相同: ${d1.batchId === d2.batchId}`);
      console.log("== 5. 获选者弃权，候补按顺序递补 ==");
      const firstWinner = d1.originalOrder[0].personId;
      out(service.abandon(d1.batchId, firstWinner));
      console.log("== 6. 重复弃权同一人（幂等，不多占名额）==");
      out(service.abandon(d1.batchId, firstWinner));
      console.log("== 7. 另一种子的独立批次 ==");
      const d3 = service.confirmDraw(ev.id, { seed: "demo-seed-B" });
      out(d3.originalOrder.map((o: any) => `${o.position}. ${o.personId} ${o.name} [${o.role}]`));
      console.log("== 8. 当前名额状态 ==");
      out(service.getBatchResult(d1.batchId).currentWinners);
      break;
    }
    default:
      console.log([
        "用法: node dist/cli.js <命令> [参数]",
        "  create-event --name N --slots 3 --seed S",
        "  import-roster --event 1 --file roster.json",
        "  draw --event 1 [--roster 1] [--seed S]   幂等确认抽签",
        "  result --batch 1                         查询原始顺序与当前状态",
        "  abandon --batch 1 --person P001          登记弃权并递补",
        "  event --id 1",
        "  demo                                     完整演示",
      ].join("\n"));
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ApiError) {
    console.error(`错误 [${err.code}] ${err.message}`);
    process.exit(2);
  }
  throw err;
}
