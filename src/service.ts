import { DatabaseSync } from "node:sqlite";
import { withTx } from "./db";
import { drawWeightedWithoutReplacement, ALGO_VERSION } from "./draw";
import { ApiError, MAX_ROSTER_SIZE, MAX_WEIGHT } from "./errors";

export interface RosterEntryInput {
  personId: string;
  name: string;
  weight: number;
}

export class LotteryService {
  constructor(private db: DatabaseSync) {}

  createEvent(input: { name: string; slots: number; seed: string }) {
    if (!input.name || typeof input.name !== "string") {
      throw new ApiError("VALIDATION", "name 必须为非空字符串");
    }
    if (!Number.isInteger(input.slots) || input.slots <= 0) {
      throw new ApiError("VALIDATION", "slots 必须为正整数");
    }
    if (!input.seed || typeof input.seed !== "string") {
      throw new ApiError("VALIDATION", "seed 必须为非空字符串");
    }
    const stmt = this.db.prepare(
      "INSERT INTO events (name, slots, seed) VALUES (?, ?, ?)",
    );
    const res = stmt.run(input.name, input.slots, input.seed);
    return this.getEvent(Number(res.lastInsertRowid));
  }

  getEvent(eventId: number) {
    const ev = this.db
      .prepare("SELECT * FROM events WHERE id = ?")
      .get(eventId) as any;
    if (!ev) throw new ApiError("NOT_FOUND", `活动 ${eventId} 不存在`, 404);
    const rosters = this.db
      .prepare(
        "SELECT id, version, frozen, created_at FROM roster_versions WHERE event_id = ? ORDER BY version",
      )
      .all(eventId) as any[];
    const batches = this.db
      .prepare(
        "SELECT id, roster_version_id, seed, algo_version, slots, status, created_at FROM batches WHERE event_id = ? ORDER BY id",
      )
      .all(eventId) as any[];
    return { ...ev, rosterVersions: rosters, batches };
  }

  /** 导入名单即冻结为新版本；任何修改必须重新导入产生新版本 */
  importRoster(eventId: number, entries: RosterEntryInput[]) {
    this.getEvent(eventId);
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new ApiError("VALIDATION", "名单不能为空");
    }
    if (entries.length > MAX_ROSTER_SIZE) {
      throw new ApiError(
        "ROSTER_TOO_LARGE",
        `名单人数 ${entries.length} 超过上限 ${MAX_ROSTER_SIZE}`,
      );
    }
    const seen = new Set<string>();
    entries.forEach((e, i) => {
      if (!e || typeof e.personId !== "string" || e.personId.length === 0) {
        throw new ApiError("VALIDATION", `第 ${i + 1} 行 personId 缺失或非法`);
      }
      if (typeof e.name !== "string" || e.name.length === 0) {
        throw new ApiError("VALIDATION", `第 ${i + 1} 行 name 缺失或非法`);
      }
      if (!Number.isInteger(e.weight) || e.weight <= 0) {
        throw new ApiError(
          "INVALID_WEIGHT",
          `第 ${i + 1} 行（${e.personId}）权重必须为正整数，收到 ${JSON.stringify(e.weight)}`,
        );
      }
      if (e.weight > MAX_WEIGHT) {
        throw new ApiError(
          "INVALID_WEIGHT",
          `第 ${i + 1} 行（${e.personId}）权重 ${e.weight} 超过上限 ${MAX_WEIGHT}`,
        );
      }
      if (seen.has(e.personId)) {
        throw new ApiError("DUPLICATE_PERSON", `编号重复：${e.personId}`);
      }
      seen.add(e.personId);
    });

    return withTx(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM roster_versions WHERE event_id = ?",
        )
        .get(eventId) as any;
      const version = row.v as number;
      const res = this.db
        .prepare(
          "INSERT INTO roster_versions (event_id, version, frozen) VALUES (?, ?, 1)",
        )
        .run(eventId, version);
      const versionId = Number(res.lastInsertRowid);
      const ins = this.db.prepare(
        "INSERT INTO roster_entries (roster_version_id, person_id, name, weight, line_no) VALUES (?, ?, ?, ?, ?)",
      );
      entries.forEach((e, i) => {
        ins.run(versionId, e.personId, e.name, e.weight, i + 1);
      });
      return { rosterVersionId: versionId, version, frozen: true, count: entries.length };
    });
  }

  getRoster(eventId: number, versionId: number) {
    const rv = this.db
      .prepare("SELECT * FROM roster_versions WHERE id = ? AND event_id = ?")
      .get(versionId, eventId) as any;
    if (!rv) {
      throw new ApiError("NOT_FOUND", `名单版本 ${versionId} 不存在`, 404);
    }
    const entries = this.db
      .prepare(
        "SELECT person_id AS personId, name, weight, line_no AS lineNo FROM roster_entries WHERE roster_version_id = ? ORDER BY line_no",
      )
      .all(versionId) as any[];
    return { ...rv, entries };
  }

  /**
   * 确认抽签：幂等。同一 (event, rosterVersion, seed) 已存在批次时直接返回既有结果。
   * seed 缺省用活动种子。
   */
  confirmDraw(eventId: number, opts: { rosterVersionId?: number; seed?: string } = {}) {
    const ev = this.getEvent(eventId);
    let versionId = opts.rosterVersionId;
    if (versionId == null) {
      const latest = this.db
        .prepare(
          "SELECT id FROM roster_versions WHERE event_id = ? ORDER BY version DESC LIMIT 1",
        )
        .get(eventId) as any;
      if (!latest) throw new ApiError("NO_ROSTER", "活动尚未导入名单");
      versionId = latest.id as number;
    }
    const roster = this.getRoster(eventId, versionId);
    const seed = opts.seed ?? (ev.seed as string);
    if (!seed) throw new ApiError("VALIDATION", "seed 不能为空");
    if (ev.slots > roster.entries.length) {
      throw new ApiError(
        "SLOTS_EXCEED_ROSTER",
        `名额 ${ev.slots} 超过候选人数 ${roster.entries.length}`,
      );
    }

    const existing = this.db
      .prepare(
        "SELECT id FROM batches WHERE event_id = ? AND roster_version_id = ? AND seed = ?",
      )
      .get(eventId, versionId, seed) as any;
    if (existing) {
      return { batchId: existing.id as number, reused: true, ...this.getBatchResult(existing.id) };
    }

    const result = drawWeightedWithoutReplacement({
      seed,
      slots: ev.slots,
      candidates: roster.entries.map((e: any) => ({ personId: e.personId, weight: e.weight })),
    });

    const batchId = withTx(this.db, () => {
      const res = this.db
        .prepare(
          "INSERT INTO batches (event_id, roster_version_id, seed, algo_version, slots) VALUES (?, ?, ?, ?, ?)",
        )
        .run(eventId, versionId, seed, ALGO_VERSION, ev.slots);
      const id = Number(res.lastInsertRowid);
      const ins = this.db.prepare(
        "INSERT INTO draw_entries (batch_id, person_id, position, role) VALUES (?, ?, ?, ?)",
      );
      result.order.forEach((pid, idx) => {
        ins.run(id, pid, idx + 1, idx < ev.slots ? "winner" : "waitlist");
      });
      return id;
    });

    return { batchId, reused: false, ...this.getBatchResult(batchId) };
  }

  getBatch(batchId: number) {
    const b = this.db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as any;
    if (!b) throw new ApiError("NOT_FOUND", `批次 ${batchId} 不存在`, 404);
    return b;
  }

  /** 原始抽取顺序 + 每次递补记录 + 当前名额状态 */
  getBatchResult(batchId: number) {
    const b = this.getBatch(batchId);
    const entries = this.db
      .prepare(
        `SELECT de.person_id AS personId, de.position, de.role, re.name, re.weight
         FROM draw_entries de
         JOIN roster_entries re ON re.roster_version_id = ? AND re.person_id = de.person_id
         WHERE de.batch_id = ? ORDER BY de.position`,
      )
      .all(b.roster_version_id, batchId) as any[];
    const replacements = this.db
      .prepare(
        "SELECT seq, abandoned_person_id AS abandoned, promoted_person_id AS promoted, note, created_at FROM replacements WHERE batch_id = ? ORDER BY seq",
      )
      .all(batchId) as any[];

    const abandoned = new Set(replacements.map((r) => r.abandoned));
    const promoted = new Set(
      replacements.filter((r) => r.promoted != null).map((r) => r.promoted),
    );
    const currentWinners = entries
      .filter((e) => (e.role === "winner" && !abandoned.has(e.personId)) || promoted.has(e.personId))
      .map((e) => e.personId);
    const vacancies = replacements.filter((r) => r.promoted == null).length;

    return {
      batch: b,
      originalOrder: entries,
      replacements,
      currentWinners,
      vacancies,
    };
  }

  /**
   * 登记弃权并递补：原子完成。
   * 重复弃权同一人返回既有记录（幂等），不会多占名额。
   * 候补用尽时记录 promoted = NULL 的空缺。
   */
  abandon(batchId: number, personId: string) {
    this.getBatch(batchId);
    const existing = this.db
      .prepare("SELECT * FROM replacements WHERE batch_id = ? AND abandoned_person_id = ?")
      .get(batchId, personId) as any;
    if (existing) {
      return { replacementId: existing.id, reused: true, promoted: existing.promoted_person_id, note: existing.note };
    }

    return withTx(this.db, () => {
      const result = this.getBatchResult(batchId);
      const entry = result.originalOrder.find((e) => e.personId === personId);
      if (!entry) {
        throw new ApiError("NOT_FOUND", `${personId} 不在该批次抽取记录中`, 404);
      }
      const isCurrentWinner = result.currentWinners.includes(personId);
      if (!isCurrentWinner) {
        throw new ApiError("NOT_WINNER", `${personId} 当前不是获选者，不能登记弃权`);
      }
      const alreadyPromoted = new Set(
        result.replacements.filter((r) => r.promoted != null).map((r) => r.promoted),
      );
      const alreadyAbandoned = new Set(result.replacements.map((r) => r.abandoned));
      const next = result.originalOrder.find(
        (e) =>
          e.role === "waitlist" &&
          !alreadyPromoted.has(e.personId) &&
          !alreadyAbandoned.has(e.personId),
      );
      const seqRow = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM replacements WHERE batch_id = ?")
        .get(batchId) as any;
      const note = next ? "" : "候补已用尽，名额空缺";
      const res = this.db
        .prepare(
          "INSERT INTO replacements (batch_id, seq, abandoned_person_id, promoted_person_id, note) VALUES (?, ?, ?, ?, ?)",
        )
        .run(batchId, seqRow.s, personId, next ? next.personId : null, note);
      return {
        replacementId: Number(res.lastInsertRowid),
        reused: false,
        promoted: next ? next.personId : null,
        note,
      };
    });
  }
}
