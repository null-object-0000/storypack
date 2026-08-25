// story build：分批量 LLM 抽取 + 断点续跑 + 重试 + 成本统计

import { loadConfig, dbPath, resolveLlmPrices, costEstimate } from "../../config.js";
import { StoryRepo } from "../../db/repo.js";
import { runBuild } from "../../build/pipeline.js";
import { createProvider } from "../../llm/index.js";
import { log, warn, section } from "../../logger.js";

export async function cmdBuild(
  flags: Record<string, string | boolean>,
  positional: string[]
): Promise<number> {
  const cfg = loadConfig();
  const repo = new StoryRepo(dbPath());
  try {
    const provider = createProvider(cfg);
    log(`LLM: ${provider.name}（model=${(provider as any).modelName ?? "?"}）`);

    const fromChapter = parseNum(flags["--from-chapter"]);
    const toChapter = parseNum(flags["--to-chapter"]);
    const batchSize = parseNum(flags["--batch-size"]) ?? cfg.build?.batchSize ?? 1;
    const retries = parseNum(flags["--retries"]) ?? cfg.build?.retries ?? 2;
    const force = flags["--force"] === true || flags["--force"] === "true";
    // 数据库快照备份（默认关闭；--backup 开启）：在构建写入前生成 .story/backups/ 一致性快照
    const backup = flags["--backup"] === true || flags["--backup"] === "true";
    if (backup) log(`数据库备份已开启：构建写入前生成 .story/backups/ 快照`);
    // 串行执行：批间存在实体/摘要依赖，--parallel 不再生效（pipeline 会忽略并警告）
    const concurrency = parseNum(flags["--parallel"]) ?? 1;
    // 默认自适应合并（按模型上下文预算自动合并章节，长书省一半以上调用）；
    // --batch-size N 回退固定批（每批 N 章）；--no-auto-batch 不存在——显式逐章用 --batch-size 1
    const autoBatch = flags["--auto-batch"] === true || flags["--auto-batch"] === "true"
      ? true
      : (flags["--batch-size"] !== undefined ? false : (cfg.build?.autoBatch ?? true));
    if (autoBatch) {
      log(`自适应合并抽取（默认）：按模型上下文预算自动合并章节（单批上限受输出预算约束）`);
    } else {
      log(`固定批模式：每批 ${batchSize} 章（--batch-size N，依赖最严格）`);
    }
    // 失败即停（默认）：依赖链断裂后不再继续，否则后续实体悬空；--keep-going 显式继续
    const failFast = !(flags["--keep-going"] === true || flags["--keep-going"] === "true");
    if (failFast) log(`失败即停已开启：某批重试后仍失败将停止后续批次（--keep-going 可继续）`);

    const started = Date.now();
    const res = await runBuild(repo, provider, {
      fromChapter,
      toChapter,
      force,
      backup,
      batchSize,
      retries,
      concurrency,
      autoBatch,
      failFast,
      sessionLog: cfg.build?.sessionLog ?? true,
      maxBatchChapters: cfg.build?.maxBatchChapters,
      perChapterOutputTokens: cfg.build?.perChapterOutputTokens,
    });

    section("Build 结果");
    for (const b of res.processed) {
      log(`[${b.range}] ${b.status === "done" ? "done" : "FAILED"}  entities:+${b.newEntities} u:${b.entityUpdates} aliases:${b.aliases} facts:${b.facts} relations:${b.relations} abilities:${b.abilities} events:${b.events} anchors:${b.memoryAnchors} dup:${b.duplicates}${b.error ? `  error: ${b.error}` : ""}`);
    }
    if (res.failed > 0) warn(`${res.failed} 个批次失败（可用 story build --force 重跑失败区间）`);

    const c = repo.counts();
    const chapters = repo.countChapters();
    const dur = ((Date.now() - started) / 1000).toFixed(1);
    log("");
    log(`Build complete（本次耗时 ${dur}s）`);
    log(`Build 索引：.story/logs/build/mainline.jsonl（runId=${res.runId}，每批一行：区间/状态/统计/token/耗时/失败原因 + session 轨迹文件关联）`);
    // ── 可观测性：千字速度 / 千字 token / 缓存命中 / 费用 ──
    try {
      const m = repo.buildMetrics("extract");
      if (m.calls > 0) {
        const charsPerSec = m.durationMs > 0 ? (m.chars / m.durationMs) * 1000 : 0;
        const kChars = m.chars / 1000;
        const inputPerK = kChars > 0 ? Math.round(m.inputTokens / kChars) : 0;
        const outPerK = kChars > 0 ? Math.round(m.outputTokens / kChars) : 0;
        const cacheHit = m.inputTokens > 0 ? (m.inputTokens - m.inputUncachedTokens) / m.inputTokens : 0;
        log(`观测      : ↓ ${formatSpeed(charsPerSec)}  输入 ${inputPerK} tok/千字（缓存命中率 ${(cacheHit * 100).toFixed(1)}%）  输出 ${outPerK} tok/千字`);
        log(`          输入合计 ${m.inputTokens.toLocaleString()}（缓存 ${(m.inputTokens - m.inputUncachedTokens).toLocaleString()}） 输出 ${m.outputTokens.toLocaleString()}  失败 ${m.failures}`);
        const price = resolveLlmPrices(cfg);
        const cost = costEstimate(m.inputTokens, m.inputUncachedTokens, m.outputTokens, price);
        const cachedTokens = m.inputTokens - m.inputUncachedTokens;
        log(`费用预估  : ¥${cost.toFixed(2)}（输入 ¥${(price.input / 1000000 * m.inputUncachedTokens).toFixed(2)} + 缓存 ¥${(price.cached / 1000000 * cachedTokens).toFixed(2)} + 输出 ¥${(price.output / 1000000 * m.outputTokens).toFixed(2)}）`);
      }
    } catch { /* 指标不可用时静默 */ }
    log(`Chapters      : ${chapters}`);
    log(`Characters    : ${c.characters}`);
    log(`Entities      : ${c.entities}`);
    log(`Aliases       : ${c.aliases}`);
    log(`Facts         : ${c.facts}`);
    log(`Relations     : ${c.relations}`);
    log(`Abilities     : ${c.abilities}`);
    log(`Events        : ${c.events}`);
    log(`Memory Anchors: ${c.memoryAnchors}`);
    log(`Appearances   : ${c.appearances}`);
    log("");
    log(`Possible duplicates: ${c.pendingDuplicates}（story review 可人工确认）`);
    log(`Open conflicts     : ${c.openConflicts}`);
    log(`Low-confidence facts: ${c.lowConfidenceFacts}`);
    return res.failed > 0 ? 2 : 0;
  } finally {
    repo.close();
  }
}

function parseNum(v: string | boolean | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : undefined;
}

/** 处理速度格式化：字符/秒 → "5.2 千字/分钟" 或 "1.3 万字/分钟" */
function formatSpeed(charsPerSec: number): string {
  if (!charsPerSec || charsPerSec <= 0) return "—";
  const perMin = charsPerSec * 60;
  return perMin >= 10000 ? `${(perMin / 10000).toFixed(1)} 万字/分钟` : `${(perMin / 1000).toFixed(1)} 千字/分钟`;
}