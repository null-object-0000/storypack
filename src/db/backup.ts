// 数据库一致性快照备份：基于 SQLite VACUUM INTO
//
// 设计要点：
//  - 用 VACUUM INTO 而非复制 .db 文件：它生成一个【事务一致】的紧凑快照，
//    即使同连接有未 checkpoint 的 WAL 数据也会一并包含，避免"复制到半截库"；
//  - 目标已存在时 VACUUM INTO 会报错 → 自动追加序号重试，绝不覆盖旧备份；
//  - 默认关闭，仅在显式调用（story build --backup 等）时执行。
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface BackupResult {
  path: string;
  bytes: number;
}

/** 可执行 VACUUM INTO 的最小接口（StoryRepo.db 即满足） */
export interface ExecableDb {
  exec(sql: string): void;
}

/**
 * 为 story.db 生成一份时间戳备份（默认目录 .story/backups/）。
 * @param db        已打开的数据库连接（用其连接做 VACUUM INTO，保证一致性）
 * @param opts.dir  备份输出目录
 * @param opts.stamp 时间戳（默认当前时间）
 */
export function backupDatabase(db: ExecableDb, opts: { dir: string; stamp?: Date }): BackupResult {
  mkdirSync(opts.dir, { recursive: true });
  const stamp = (opts.stamp ?? new Date())
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "");
  // 同秒冲突时自动追加序号，绝不覆盖已有备份
  let file = join(opts.dir, `story-${stamp}.db`);
  for (let n = 1; statSyncSafe(file); n++) file = join(opts.dir, `story-${stamp}-${n}.db`);
  const lit = file.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${lit}'`);
  return { path: file, bytes: statSync(file).size };
}

function statSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
