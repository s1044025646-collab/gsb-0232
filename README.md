# 福利名额抽签与候补递补服务（本地后端）

使用 TypeScript + Node.js + SQLite 实现的本地福利名额抽签服务，只提供 HTTP API 与 CLI，无前端、不接支付、不接真实用户系统。名单内全部为虚构人员。

## 环境要求

- Windows 本地，Node.js >= 22.5（使用内置 `node:sqlite`，无需 Docker / WSL / 外部服务）
- 开发使用 Node 25 验证；源码为 TypeScript，Node 22.6+ 可直接运行（类型擦除），也可用 `npm run build` 编译到 `dist/`

## 快速开始

```powershell
npm install        # 安装开发依赖（typescript、@types/node）
npm test           # 运行测试（15 个用例）
npm run build      # 编译到 dist/
npm run demo       # 一键演示：固定种子抽签、重复确认、弃权递补、独立批次、权重效果
npm start          # 启动 API（默认端口 0 = 自动选空闲端口）
```

## 核心概念

### 名单冻结与版本

- 每次导入名单产生一个新的**名单版本**（`roster_versions`），内容为按编号排序后的快照 JSON。
- 版本必须显式 `freeze` 后才能用于抽签；冻结后不可修改、不可重复冻结。
- 修改名单只能再次导入产生新版本；已执行的抽签批次绑定旧版本快照，输入不会被暗中改变。

### 抽签算法（`weighted-swor-v1`）

加权不放回抽取，见 `src/draw.ts`：

1. 候选人按 `id` 字典序排序 —— 输入文件行序不影响结果；
2. 每轮计算剩余候选人权重总和 `total`，取 `r = rng() * total`；
3. 按排序顺序累计权重，`r` 落在谁的区间谁被选中；
4. 选中者移出池子，重复直到池空，得到完整顺序：前 `quota` 名为获选者，其余按序为候补。

随机源是种子化的 `mulberry32`（`src/rng.ts`），**不使用 `Math.random`**。同一（冻结名单快照, 种子, 算法版本）必然得到同一结果。

### 候补递补

- 获选者登记弃权后，立即按最初抽取顺序取下一位候补递补，**不重新摇号**；
- 弃权与递补在同一事务中原子完成；重复弃权幂等，不会多占名额；
- 候补用尽时记录空缺（`vacant`），结果中 `vacancies` 计数。

### 保证范围（明确声明）

- 只保证**本地确定性复现**：给定相同输入可核对相同输出；
- **不提供**密码学随机性、外部公证、抗操纵证明或大规模统计证明；
- `mulberry32` 不是密码学安全随机源，请勿用于有安全对抗场景。

## CLI 用法

```powershell
# 创建活动（名额 4，种子 42，可选候选规模/权重上限）
node src/cli.ts create-event --name "春季观影福利" --quota 4 --seed 42

# 导入名单（支持 .json 或 .csv），产生版本 1
node src/cli.ts import-roster --event 1 --file data/sample-roster.json

# 冻结名单版本
node src/cli.ts freeze --event 1 --version 1

# 确认抽签（幂等：重复执行返回既有结果，reused=true）
node src/cli.ts draw --event 1

# 查询原始顺序与当前名额状态
node src/cli.ts result --event 1

# 获选者弃权，自动递补
node src/cli.ts forfeit --event 1 --candidate C008

# 启动 API，--port 0 或省略表示自动选空闲端口
node src/cli.ts serve --port 8080
```

所有命令支持 `--db <路径>` 指定数据库文件，默认 `data/lottery.db`。

名单 CSV 格式（`id,name,weight` 每行一条，`#` 开头为注释）：

```csv
# id,name,weight
C001,林晓雨,1
C002,陈志远,2
```

## HTTP API

启动：`npm start`（或 `node src/cli.ts serve --port 8080`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/events` | 创建活动 `{name, quota, seed, maxCandidates?, maxWeight?}` |
| POST | `/events/:id/rosters` | 导入名单新版本 `{candidates: [{id, name, weight}]}` |
| POST | `/events/:id/rosters/:version/freeze` | 冻结名单版本 |
| POST | `/events/:id/draws` | 确认抽签 `{version?}`，幂等 |
| GET | `/events/:id/result` | 查询原始顺序与当前名额状态 |
| POST | `/events/:id/forfeits` | 登记弃权并递补 `{candidateId}` |

错误统一返回：

```json
{ "error": { "code": "INVALID_WEIGHT", "message": "候选人 C001 的权重必须是 >= 1 的整数，收到: 0" } }
```

### 错误码

| 错误码 | 含义 |
| --- | --- |
| `INVALID_INPUT` | 参数缺失或类型错误 |
| `INVALID_WEIGHT` | 权重非正整数或超过上限 |
| `DUPLICATE_CANDIDATE_ID` | 候选人编号重复 |
| `TOO_MANY_CANDIDATES` | 候选人数超过上限 |
| `QUOTA_EXCEEDS_CANDIDATES` | 名额数超过候选人数 |
| `EVENT_NOT_FOUND` / `ROSTER_NOT_FOUND` / `DRAW_NOT_FOUND` | 资源不存在 |
| `ROSTER_NOT_FROZEN` | 名单未冻结不能抽签 |
| `ROSTER_ALREADY_FROZEN` | 重复冻结 |
| `CANDIDATE_NOT_WINNER` | 非当前获选者不能登记弃权 |

## 数据存储

SQLite 文件默认在 `data/lottery.db`（WAL 模式）。表：

- `events`：活动（名额、种子、算法版本、上限配置）
- `roster_versions`：名单版本与冻结快照（JSON）
- `draw_batches`：抽签批次，`UNIQUE(event_id, roster_version_id, seed)` 保证幂等
- `draw_entries`：完整抽取顺序（位置、获选/候补）
- `forfeits` / `promotions`：弃权与递补记录（含空缺 `vacant`）

一次确认抽签、一次弃权+递补分别在单个事务中完成；服务重启后可通过 `result` 核对原始顺序与当前名额状态。

## 演示

`npm run demo` 使用独立数据库 `data/demo.db` 与 `data/sample-roster.json`（12 名虚构人员）演示：

1. 创建活动（名额 4，种子 42）并导入、冻结名单；
2. 固定种子抽签：获选 `C008 郑凯文、C006 周浩然、C012 罗天佑、C007 吴思彤`；
3. 重复确认返回 `reused=true`，不重新抽；
4. `C008` 弃权，候补第一顺位 `C002 陈志远` 递补；重复弃权幂等；
5. 种子 7 的第二批次产生独立结果；
6. 权重效果样例：4 人中 D 权重 30、其余 1，种子 1..40 中 D 首个被抽中 36/40 次（期望约 30/33 ≈ 91%）——权重影响概率而非按大小直接排序选走。

## 测试

`npm test` 覆盖：预确定种子结果、无重复人员、输入行序无关、权重效果可复现、零权重/非法权重/权重上限、重复编号、名额超出人数、全员获选、未冻结/重复冻结、重复确认幂等、弃权递补与重复弃权幂等、候补用尽记录空缺、非获选者弃权拒绝、重启后结果核对。

## 目录结构

```
src/draw.ts     加权不放回抽取算法（weighted-swor-v1）
src/rng.ts      mulberry32 种子化 PRNG
src/db.ts       SQLite 打开与建表
src/service.ts  业务逻辑与事务
src/api.ts      HTTP API
src/cli.ts      命令行入口
src/demo.ts     演示脚本
src/errors.ts   错误码
test/           node:test 测试
data/           示例名单与数据库文件
```
