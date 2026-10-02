import { openDb, DEFAULT_DB_PATH } from "./db";
import { LotteryService } from "./service";
import { createServer } from "./server";

const dbPath = process.env.LOTTERY_DB ?? DEFAULT_DB_PATH;
const port = Number(process.env.PORT ?? 0);

const service = new LotteryService(openDb(dbPath));
const server = createServer(service);
server.listen(port, () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`抽签服务已启动: http://127.0.0.1:${actual}  (数据库: ${dbPath})`);
});
