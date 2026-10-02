import fs from 'node:fs';
import path from 'node:path';
import { openDb, DEFAULT_DB_PATH } from './db.ts';
import { startServer } from './api.ts';
import {
  confirmDraw,
  createEvent,
  forfeit,
  freezeRoster,
  getResult,
  importRoster,
} from './service.ts';
import { runDemo } from './demo.ts';

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const [cmd = 'help', ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = 'true';
      }
    }
  }
  return { cmd, opts };
}

function need(opts: Record<string, string>, key: string): string {
  const v = opts[key];
  if (v === undefined) {
    console.error(`缺少参数 --${key}`);
    process.exit(2);
  }
  return v;
}

function print(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

function loadRosterFile(file: string): unknown {
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  if (file.endsWith('.json')) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.candidates;
  }
  // CSV: id,name,weight 每行一条，允许 # 注释与表头
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^id\s*,/i.test(l));
  return rows.map((line) => {
    const [id, name, weight] = line.split(',').map((s) => s.trim());
    return { id, name, weight: Number(weight) };
  });
}

const HELP = `福利名额抽签 CLI
用法: node src/cli.ts <命令> [参数]

  serve [--port N]                       启动 HTTP API（默认端口 0 = 自动选空闲端口）
  create-event --name N --quota Q --seed S [--max-candidates N] [--max-weight N]
  import-roster --event ID --file PATH   导入名单（.json 或 .csv），生成新版本
  freeze --event ID --version V          冻结名单版本
  draw --event ID [--version V]          确认抽签（幂等，重复执行返回既有结果）
  result --event ID                      查询原始顺序与当前名额状态
  forfeit --event ID --candidate CID     登记弃权并自动递补
  demo                                   运行完整演示（独立 demo 数据库）
`;

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }
  if (cmd === 'demo') {
    runDemo();
    return;
  }

  const db = openDb(opts.db ? path.resolve(opts.db) : DEFAULT_DB_PATH);

  switch (cmd) {
    case 'serve': {
      const port = opts.port === undefined ? 0 : Number(opts.port);
      const { port: actual } = await startServer(db, port);
      console.log(`API 服务已启动: http://127.0.0.1:${actual}  (数据库: ${DEFAULT_DB_PATH})`);
      break;
    }
    case 'create-event':
      print(
        createEvent(db, {
          name: need(opts, 'name'),
          quota: Number(need(opts, 'quota')),
          seed: Number(need(opts, 'seed')),
          maxCandidates: opts['max-candidates'] ? Number(opts['max-candidates']) : undefined,
          maxWeight: opts['max-weight'] ? Number(opts['max-weight']) : undefined,
        }),
      );
      break;
    case 'import-roster':
      print(importRoster(db, Number(need(opts, 'event')), loadRosterFile(need(opts, 'file'))));
      break;
    case 'freeze':
      print(freezeRoster(db, Number(need(opts, 'event')), Number(need(opts, 'version'))));
      break;
    case 'draw':
      print(confirmDraw(db, Number(need(opts, 'event')), opts.version ? Number(opts.version) : undefined));
      break;
    case 'result':
      print(getResult(db, Number(need(opts, 'event'))));
      break;
    case 'forfeit':
      print(forfeit(db, Number(need(opts, 'event')), need(opts, 'candidate')));
      break;
    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((e) => {
  if (e && typeof e === 'object' && 'code' in e) {
    const err = e as { code: string; message: string };
    console.error(`错误 [${err.code}] ${err.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
