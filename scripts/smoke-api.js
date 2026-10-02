// API 冒烟测试：启动服务 -> 创建活动 -> 导入名单 -> 抽签 -> 重复确认 -> 弃权递补 -> 查询
const { openDb } = require("../dist/db");
const { LotteryService } = require("../dist/service");
const { createServer } = require("../dist/server");

async function main() {
  const service = new LotteryService(openDb("data/api-smoke.db"));
  const server = createServer(service);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) =>
    fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json());
  const get = (p) => fetch(base + p).then((r) => r.json());

  const ev = await post("/events", { name: "API冒烟", slots: 2, seed: "api-seed" });
  console.log("event:", ev.id);
  const entries = require("../examples/roster.json");
  console.log("roster:", await post(`/events/${ev.id}/rosters`, { entries }));
  const d1 = await post(`/events/${ev.id}/draws`, {});
  console.log("draw batch:", d1.batchId, "reused:", d1.reused,
    d1.originalOrder.map((o) => `${o.personId}[${o.role}]`).join(" "));
  const d2 = await post(`/events/${ev.id}/draws`, {});
  console.log("re-confirm batch:", d2.batchId, "reused:", d2.reused);
  const winner = d1.originalOrder[0].personId;
  console.log("abandon:", await post(`/events/${ev.id}/draws/${d1.batchId}/abandon`, { personId: winner }));
  const state = await get(`/events/${ev.id}/draws/${d1.batchId}`);
  console.log("currentWinners:", state.currentWinners.join(","));
  const bad = await post(`/events/${ev.id}/rosters`, { entries: [{ personId: "X", name: "错", weight: 0 }] });
  console.log("error case:", bad);
  server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
