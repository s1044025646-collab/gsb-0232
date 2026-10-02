# 福利名额抽签与候补递补服务（本地）

使用 TypeScript + Node.js + SQLite 实现的本地福利名额抽签后端，只提供 HTTP API 与 CLI，
不涉及支付、真实用户系统或任何外部在线服务。所有数据均为虚构演示数据。

## 功能概览

- 活动管理：名称、名额数（slots）、默认种子（seed）
- 名单管理：导入即冻结为不可变快照版本；修改名单必须重新导入产生新版本
- 可复现加权不放回抽签：同一名单快照 + 种子 + 算法版本 => 相同结果
- 幂等确认：同一（活动、名单版本、种子）重复确认返回既有批次，不重新抽取
- 候补递补：获选者弃权后按最初抽取顺序依次递补，不重新摇号；重复弃权幂等
- 候补用尽时明确记录空缺（vacancy）
- SQLite 持久化：名单快照、种子、算法版本、完整抽取顺序、每次递补记录；
  确认与递补各自在事务中原子完成，重启后可核对原始结果与当前名额状态

## 环境要求

- Windows 本地，Node.js >= 22.5（使用内置 `node:sqlite`，无需原生编译、Docker 或 WSL）
- 当前开发验证环境：Node v25.5.0

## 构建 / 测试 / 启动

```powershell
npm install        # 安装 devDependencies（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试（node:test）
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo       # CLI 完整演示（固定种子抽签、重复确认、弃权递补、第二种子批次）
```

配置项（环境变量）：

- `PORT`：HTTP 端口，默认 `0`（由系统分配空闲端口，启动日志会打印实际端口）
- `LOTTERY_DB`：SQLite 数据库文件路径，默认 `项目目录/data/lottery.db`

## 抽签算法与保证范围

算法版本：`weighted-wr-v1`（见 `src/draw.ts`、`src/rng.ts`）。

1. 候选人先按 `personId` 字典序排序，输入文件行序不影响结果。
2. 随机源为 cyrb128(种子字符串) + mulberry32 的种子化 PRNG，**不使用 `Math.random`**；
   种子材料为 `"weighted-wr-v1|<seed>"`，算法版本变化会得到不同序列。
3. 每轮在剩余候选人的累计权重区间 `[0, total)` 上取一个均匀样本，命中者被选中
   并从后续轮次移除（不放回），直到所有人排出完整顺序。
4. 前 `slots` 名为获选者，其余按顺序为候补。

保证范围：

- 仅保证**本地确定性复现**：同一冻结名单、种子、算法版本必然得到相同顺序。
- 权重只影响被选中概率（每轮按权重比例抽样），不是按权重大小直接排序选走。
- **不提供**密码学级随机性、外部公证或大规模统计公平性证明。

## 校验与错误码

限制：名单最多 5000 人，权重为 1..10000 的整数（见 `src/errors.ts`）。

| 错误码 | 含义 |
| --- | --- |
| `VALIDATION` | 参数缺失或非法（如 slots 非正整数、JSON 非法） |
| `NOT_FOUND` | 活动 / 名单版本 / 批次 / 人员不存在 |
| `DUPLICATE_PERSON` | 名单内编号重复 |
| `INVALID_WEIGHT` | 权重为零、负数、非整数或超过上限 |
| `ROSTER_TOO_LARGE` | 名单人数超过上限 |
| `SLOTS_EXCEED_ROSTER` | 名额数超过候选人数 |
| `NO_ROSTER` | 尚未导入名单就确认抽签 |
| `NOT_WINNER` | 对非当前获选者登记弃权 |

错误响应格式：`{ "error": { "code": "...", "message": "..." } }`。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/events` | 创建活动 `{name, slots, seed}` |
| GET | `/events/:id` | 活动详情（含名单版本与批次列表） |
| POST | `/events/:id/rosters` | 导入名单并冻结新版本 `{entries:[{personId,name,weight}]}` |
| GET | `/events/:id/rosters/:versionId` | 查看名单快照 |
| POST | `/events/:id/draws` | 幂等确认抽签 `{rosterVersionId?, seed?}` |
| GET | `/events/:id/draws/:batchId` | 查询原始顺序、递补记录与当前名额状态 |
| POST | `/events/:id/draws/:batchId/abandon` | 登记弃权并递补 `{personId}` |

示例（PowerShell）：

```powershell
npm start   # 记下打印的端口，例如 51234
$base = "http://127.0.0.1:51234"
Invoke-RestMethod -Method Post -Uri "$base/events" -ContentType 'application/json' `
  -Body '{"name":"年终福利","slots":3,"seed":"demo-seed"}'
```

## CLI

CLI 直接操作同一个 SQLite 数据库（`LOTTERY_DB` 可指定路径）：

```powershell
node dist/cli.js create-event --name 年终福利 --slots 3 --seed demo-seed
node dist/cli.js import-roster --event 1 --file examples/roster.json
node dist/cli.js draw --event 1                      # 幂等确认抽签
node dist/cli.js draw --event 1                      # 再次执行：reused=true，结果不变
node dist/cli.js result --batch 1                    # 原始顺序 + 递补记录 + 当前状态
node dist/cli.js abandon --batch 1 --person P002     # 弃权并递补
node dist/cli.js draw --event 1 --seed other-seed    # 另一种子的独立批次
node dist/cli.js demo                                # 一键完整演示
```

## 演示说明

`npm run demo` 使用 `src/cli.ts` 内置的 8 人虚构名单（与 `examples/roster.json` 相同）演示：

1. 创建 3 个名额、种子 `demo-seed` 的活动
2. 导入名单并冻结为版本 1
3. 固定种子抽签，输出完整获选/候补顺序
4. 再次确认：`reused=true`，返回既有批次，不重新抽
5. 第一名获选者弃权，候补第 1 位递补
6. 重复弃权同一人：幂等返回既有记录，不多占名额
7. 用种子 `demo-seed-B` 产生独立批次（顺序不同）
8. 输出当前实际获选名单

## 项目结构

```
src/rng.ts       种子化 PRNG（cyrb128 + mulberry32）
src/draw.ts      加权不放回抽取（算法版本 weighted-wr-v1）
src/db.ts        SQLite 连接、建表、事务辅助
src/service.ts   业务逻辑：活动/名单/抽签/递补
src/server.ts    HTTP API（node:http，无外部依赖）
src/cli.ts       命令行入口与 demo
src/index.ts     服务启动入口
test/            node:test 测试（17 个用例）
examples/roster.json  虚构示例名单
scripts/smoke-api.js  API 冒烟脚本
```

## 已知限制

- `node:sqlite` 在 Node 25 仍标记为 experimental（启动时有警告），接口未来可能微调。
- 单机单进程设计，无鉴权、无并发多写保护（事务保证单进程内原子性）。
- 仅模拟免费名额分配，不含资格表达式、家庭配额、多轮竞价等复杂规则。
