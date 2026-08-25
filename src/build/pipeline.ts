// Build Pipeline：分批次 LLM 抽取 → schema 校验 → 入库 → 断点续跑 → 日志
// 硬约束：任何抽取/入库行为只允许落在【当前 Batch 范围】[start, end] 内（见 validation.ts）。
// 默认构建范围 = 当前已导入但尚未构建的全部章节（availableThrough 起，builtThrough 续）。

import { StoryRepo } from "../db/repo.js";
import { backupDatabase } from "../db/backup.js";
import { join } from "node:path";
import { LlmProvider, ChapterSlice, ExtractionInput } from "../llm/types.js";
import { validateExtractionOutput, buildValidationFeedback, ValidationError, ExtractionBundle } from "./validation.js";
import { aliasClashToDuplicate } from "./resolution.js";
import { agentExtract } from "./agent-extractor.js";
import { BuildSessionLogger, BuildMainlineLogger } from "./session-log.js";
import { log, warn } from "../logger.js";
import { clampInt, estimateTokens, sleep } from "../util.js";

export interface BuildOptions {
  fromChapter?: number;
  toChapter?: number;
  force?: boolean;
  batchSize?: number;
  retries?: number;
  concurrency?: number;
  /** 自适应合并：按模型上下文动态决定每批章节数（默认 true，取 cfg.build.autoBatch） */
  autoBatch?: boolean;
  /** 单批章节数上限（防单批过大） */
  maxBatchChapters?: number;
  /** 每章结构化输出的 token 估算（用于输出预算） */
  perChapterOutputTokens?: number;
  /** 模型上下文窗口（tokens）；缺省时尝试 provider.getCapabilities() */
  contextWindow?: number;
  /** 模型单次最大输出（tokens） */
  maxTokens?: number;
  /** 进度回调（每批完成时触发，用于 TUI 实时更新） */
  onProgress?: (progress: BuildProgress) => void;
  /**
   * 失败即停：批间存在实体/摘要依赖，某批重试后仍失败时，后续批次不应继续
   * （后面的抽取会引用缺失的实体，产生悬空引用）。
   * 默认 true（停止并保留未执行批次）；--keep-going 可显式继续。
   */
  failFast?: boolean;
  /** 会话日志：每批把完整 prompt/回复/工具轨迹落盘为 JSONL（.story/logs/build/），
   *  供性能与准确度分析。默认 true（agent 抽取时生效）。 */
  sessionLog?: boolean;
  /** 取消信号：批间检查；abort 后不再开始新批次（当前批次完成后停止）。用于 TUI 构建面板 Esc 取消。 */
  signal?: AbortSignal;
  /** 构建开始前对 story.db 做一致性快照备份（默认关闭；--backup 开启）。输出到 .story/backups/，
   *  为 --force 全量重跑提供可回滚点（VACUUM INTO，事务一致、含 WAL 已提交数据）。 */
  backup?: boolean;
}

export interface BuildProgress {
  /** 当前批次区间（如 "1-5"；status=running 时是刚开始的批次） */
  range: string;
  /** running=开始处理（LLM 调用中），done/failed=批次结束 */
  status: "running" | "done" | "failed";
  /** 当前批次结果（running 时为零值） */
  counts: BatchResult;
  /** 已结束（done+failed）的批次数 */
  doneCount: number;
  /** 总批次数 */
  totalCount: number;
  /** 失败批次数 */
  failedCount: number;
  /** 已完成章节数（章级进度，按批次跨度累加） */
  doneChapters: number;
  /** 待处理总章节数 */
  totalChapters: number;
  /** 当前正在处理的批次（用于实时显示） */
  running: string[];
  /** 当前批次运行日志（Agent 活动：调用工具 / 生成 JSON 等），供 UI 实时显示，避免干等 */
  statusLine?: string;
}

export interface BatchResult {
  range: string;
  status: "done" | "failed";
  /** 失败原因（如校验错误、入库错误）；成功批次为空 */
  error?: string;
  newEntities: number;
  entityUpdates: number;
  aliases: number;
  facts: number;
  relations: number;
  abilities: number;
  events: number;
  memoryAnchors: number;
  duplicates: number;
}

export async function runBuild(repo: StoryRepo, provider: LlmProvider, opts: BuildOptions): Promise<{
  processed: BatchResult[];
  skipped: number;
  failed: number;
  /** 本次构建的 runId（与 mainline.jsonl 索引日志对应） */
  runId: string;
}> {
  const batchSize = Math.max(1, opts.batchSize ?? 1);
  const retries = Math.max(0, opts.retries ?? 2);

  const chapterCount = repo.countChapters();
  if (chapterCount === 0) {
    throw new Error("chapters 表为空，请先运行：story import <小说文件>");
  }
  // availableThrough：当前已导入的最大章节（由 chapters 数据自动决定，非配置）
  const dbMax = repo.availableThrough() ?? 0;
  if (dbMax === 0) {
    throw new Error("chapters 表为空，请先运行：story import <小说文件>");
  }
  // --to-chapter 在本命令中是【本次构建任务的结束章节】（与 Reader 防剧透无关）；缺省 = 全部已导入章节
  const toChapter = clampInt(opts.toChapter ?? dbMax, 1, dbMax);
  const fromChapter = clampInt(opts.fromChapter ?? 1, 1, toChapter);

  // ── 模型能力与预算（自适应分批用） ──
  const caps = provider.getCapabilities?.();
  const contextWindow = Math.max(16000, opts.contextWindow ?? caps?.contextWindow ?? 128000);
  const maxTokens = Math.max(1024, opts.maxTokens ?? caps?.maxTokens ?? 8192);
  const autoBatch = opts.autoBatch ?? true;
  const maxBatchChapters = Math.max(1, opts.maxBatchChapters ?? 60);
  const perChapterOutput = Math.max(80, opts.perChapterOutputTokens ?? 320);
  // 固定开销：system prompt + JSON 指令 + 输出外壳 + 实体索引（粗估）
  const fixedOverhead = 3000;
  // 输入预算：上下文减去输出预留，留 10% 安全余量
  const inputBudget = Math.floor((contextWindow - maxTokens) * 0.9 - fixedOverhead);
  // 输出预算：单批输出不得超出 maxTokens 的 85%（防 JSON 截断）
  const maxByOutput = Math.max(1, Math.floor((maxTokens * 0.85) / perChapterOutput));
  const effectiveMaxBatch = Math.min(maxBatchChapters, maxByOutput);

  // 生成批次（固定 or 自适应）
  const ranges: { start: number; end: number }[] = [];
  if (!autoBatch) {
    for (let s = fromChapter; s <= toChapter; s += batchSize) {
      ranges.push({ start: s, end: Math.min(s + batchSize - 1, toChapter) });
    }
  } else {
    let start = fromChapter;
    let acc = 0;
    let n = 0;
    for (let c = fromChapter; c <= toChapter; c++) {
      const text = repo.getChapterText(c);
      const ct = text ? estimateTokens(text) : 0;
      if (n > 0 && (acc + ct > inputBudget || n >= effectiveMaxBatch)) {
        ranges.push({ start, end: c - 1 });
        start = c;
        acc = 0;
        n = 0;
      }
      acc += ct;
      n++;
    }
    if (n > 0) ranges.push({ start, end: toChapter });
    if (ranges.length > 0 && ranges[ranges.length - 1].end < toChapter) {
      ranges[ranges.length - 1] = { ...ranges[ranges.length - 1], end: toChapter };
    }
    log(`自适应批量：上下文 ${contextWindow} / 输出 ${maxTokens} → 每批最多 ${effectiveMaxBatch} 章（共 ${ranges.length} 批）`);
  }

  // 断点续跑：跳过已完成批次（除非 --force）
  const pending: { start: number; end: number }[] = [];
  let skipped = 0;
  // 章级覆盖判断：某章是否已被"任意" done 批次覆盖（兼容批次大小变化——如 5 章批变 10 章批后
  // 精确 range 对不上，但按章算这些章节早已构建过，不该重复抽取）。
  const coveredChapters = new Set<number>();
  if (!opts.force) {
    for (const b of repo.listBatches().filter((bb) => bb.status === "done")) {
      const [s, e] = b.range.split("-").map(Number);
      if (Number.isInteger(s) && Number.isInteger(e)) {
        for (let c = s; c <= e; c++) coveredChapters.add(c);
      }
    }
  }
  const chapterCoveredByDone = (c: number): boolean => coveredChapters.has(c);
  for (const r of ranges) {
    const key = `${r.start}-${r.end}`;
    if (!opts.force) {
      const state = repo.getBatch(key);
      if (state?.status === "done") {
        skipped++;
        continue;
      }
      // 本批每一章都已被任意 done 批次覆盖 → 整批跳过（部分覆盖的批次整批重做，避免复杂的部分续跑）
      let allCovered = true;
      for (let c = r.start; c <= r.end; c++) {
        if (!chapterCoveredByDone(c)) {
          allCovered = false;
          break;
        }
      }
      if (allCovered) {
        skipped++;
        continue;
      }
    }
    pending.push(r);
  }
  if (!opts.force && skipped > 0) {
    log(`跳过已完成的批次：${skipped} 个（使用 --force 可重新抽取）`);
  }

  const processed: BatchResult[] = [];
  let failed = 0;
  let doneCount = 0;
  let doneChapters = 0;
  const totalBatches = pending.length;
  const totalChapters = pending.reduce((s, r) => s + (r.end - r.start + 1), 0);
  /** 正在处理的批次（running 状态，实时显示） */
  const running: string[] = [];

  // ── 主线/索引日志（.story/logs/build/mainline.jsonl）：串联本次构建每一批 build 情况 ──
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const mainline = new BuildMainlineLogger(process.cwd());
  const runStart = Date.now();
  const runTokens = { input: 0, cached: 0, output: 0 };
  let runChars = 0;
  mainline.write({
    kind: "run_start", runId,
    provider: provider.name,
    model: (provider as any).modelName ?? provider.name,
    fromChapter, toChapter,
    batchSize, autoBatch, failFast: opts.failFast ?? true, retries,
    ranges: ranges.length, pending: pending.length, skipped,
    sessionLogDir: ".story/logs/build",
  });

  const zeroResult = (range: string, status: "done" | "failed"): BatchResult => ({ range, status, ...zeroCounts() });
  const spanOf = (range: string): number => {
    const [a, b] = range.split("-").map(Number);
    return Number.isInteger(a) && Number.isInteger(b) ? b - a + 1 : 0;
  };
  const emitProgress = (range: string, status: BuildProgress["status"], counts: BatchResult, statusLine?: string): void => {
    if (status === "done") {
      doneCount++;
      doneChapters += spanOf(range);
    } else if (status === "failed") {
      failed++;
      doneChapters += spanOf(range);
    }
    opts.onProgress?.({
      range,
      status,
      counts,
      doneCount,
      totalCount: totalBatches,
      failedCount: failed,
      doneChapters,
      totalChapters,
      running: [...running],
      ...(statusLine !== undefined ? { statusLine } : {}),
    });
  };

  // 单批处理
  async function processBatch(r: { start: number; end: number }): Promise<void> {
    const key = `${r.start}-${r.end}`;
    running.push(key);
    let statusLine: string | undefined;

    /** 本批索引行：串联区间/状态/产出统计/token/耗时/失败原因与完整 session 轨迹文件（mainline.jsonl） */
    const writeIndex = (br: BatchResult, info: {
      usage: { input: number; cached: number; output: number };
      chars: number;
      durationMs: number;
      attempts: number;
      summary: string | null;
      sessionLog: string | null;
      /** Evidence Grounding：本批带 evidence 的 temporal 记录数 / 非致命 warning 数（可观测性，不存原文） */
      evidenceValidated?: number;
      evidenceWarnings?: number;
    }): void => {
      mainline.write({
        kind: "batch", runId,
        range: key, startChapter: r.start, endChapter: r.end, nChapters: r.end - r.start + 1,
        status: br.status,
        attempts: info.attempts,
        counts: {
          newEntities: br.newEntities, entityUpdates: br.entityUpdates,
          aliases: br.aliases, facts: br.facts, relations: br.relations,
          abilities: br.abilities, events: br.events,
          memoryAnchors: br.memoryAnchors, duplicates: br.duplicates,
        },
        tokens: info.usage,
        chars: info.chars,
        durationMs: info.durationMs,
        summary: info.summary,
        error: br.error ?? null,
        sessionLog: info.sessionLog,
        evidenceValidated: info.evidenceValidated ?? null,
        evidenceWarnings: info.evidenceWarnings ?? null,
      });
      runTokens.input += info.usage.input;
      runTokens.cached += info.usage.cached;
      runTokens.output += info.usage.output;
      runChars += info.chars;
    };

    emitProgress(key, "running", zeroResult(key, "done"), "准备批次...");
    log(`[${key}] extracting...`);
    // 批内每章文本预算（输入预算均分；中文 ~0.6~0.7 token/字，保守按 0.6 换算字符）
    const nChapters = Math.max(1, r.end - r.start + 1);
    const perChapterTokenBudget = Math.max(600, Math.floor((inputBudget - fixedOverhead) / nChapters));
    const perChapterCharBudget = Math.floor(perChapterTokenBudget / 0.6);
    const texts: ChapterSlice[] = [];
    for (let c = r.start; c <= r.end; c++) {
      const text = repo.getChapterText(c);
      if (text === null) continue;
      const meta = repo.listChapterMeta().find((m) => m.chapter === c);
      texts.push({ chapter: c, title: meta?.title ?? "", text: text.slice(0, perChapterCharBudget) });
    }
    if (texts.length === 0) {
      warn(`[${key}] 无章节文本，跳过`);
      const zero = zeroCounts();
      const br: BatchResult = { range: key, status: "failed", error: "无章节文本", ...zero };
      processed.push(br);
      running.splice(running.indexOf(key), 1);
      writeIndex(br, { usage: { input: 0, cached: 0, output: 0 }, chars: 0, durationMs: 0, attempts: 1, summary: null, sessionLog: null });
      emitProgress(key, "failed", br);
      return;
    }

    // 只支持 Agent 化抽取（模型用 search_existing_entities 工具按需检索已有实体）；注入式已移除
    if (!provider.getAgentKit?.()) {
      throw new Error("当前 provider 不支持 Agent 化抽取（缺少 getAgentKit）");
    }

    // 会话日志：把本批完整轨迹落盘（.story/logs/build/）
    let batchSessionLog: BuildSessionLogger | null = null;
    if (opts.sessionLog ?? true) {
      batchSessionLog = new BuildSessionLogger(process.cwd());
      batchSessionLog.open(key);
    }
    const sessionLogForAgent = batchSessionLog ?? undefined;

    // 滚动摘要
    const previousSummary = rollPreviousSummary(repo, r.start);

    const input: ExtractionInput = {
      range: key,
      startChapter: r.start,
      endChapter: r.end,
      texts,
      previousSummary,
    };

    // 调用 + 校验 + 重试
    let bundle: ExtractionBundle | null = null;
    let lastError = "";
    // 校验失败的反馈：回填给下一次尝试，让重试"会修"而不是盲目重跑同一 prompt
    let feedback = "";
    /** 上一次尝试的完整输出（ValidationError 重试时回传给模型，让它只修被点名记录、其余逐字不动——
     *  避免重试从头重生成整份 JSON 而改坏其他本来正确的记录，这是"打地鼠"问题的根治）。 */
    let previousOutput: string | undefined;
    let usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
    /** 本次尝试的原始输出（校验失败时用于点名定位非法条目，构建更有针对性的反馈） */
    let rawOutput: unknown = null;
    const batchChars = texts.reduce((s, t) => s + t.text.length, 0);
    const t0 = Date.now();
    let attempt = 0;
    for (; attempt <= retries; attempt++) {
      if (attempt > 0) {
        log(`  [${key}] 校验失败：${feedback || lastError}（第 ${attempt} 次修复重试...）`);
        await sleep(500 * attempt);
      }
      try {
        const res = await agentExtract(provider, repo, { ...input, feedback, previousOutput }, {
          onActivity: (line) => {
            statusLine = line;
            emitProgress(key, "running", zeroResult(key, "done"), statusLine);
          },
          sessionLog: sessionLogForAgent,
        });
        usage = res.usage;
        rawOutput = res.output;
        // 设计原则：校验错误不在这里"悄悄修数据"，而是由反馈循环回传给 LLM，
        // 让模型自己修正输出（见下方 catch 里的 feedback 回填 + prompts.buildFixInstruction）。
        // 章节原文 map：Evidence Grounding 校验（chapter+evidence 必须在对应章节原文中确定性验证）。
        const chapterTexts = new Map<number, string>();
        for (const t of texts) chapterTexts.set(t.chapter, t.text);
        bundle = validateExtractionOutput(res.output, r.start, r.end, chapterTexts);
        // 校验通过：记录结构化产出统计（准确度分析用）
        batchSessionLog?.write({
          t: "validated", range: key,
          ok: true,
          counts: {
            newEntities: bundle.newEntities.length,
            aliases: bundle.aliases.length,
            facts: bundle.facts.length,
            relations: bundle.relations.length,
            abilities: bundle.abilities.length,
            events: bundle.events.length,
            memoryAnchors: bundle.memoryAnchors.length,
            possibleDuplicates: bundle.possibleDuplicates.length,
          },
          evidenceWarnings: bundle.warnings,
          batchSummary: bundle.batchSummary,
        });
        for (const w of bundle.warnings) {
          warn(`  [${key}] 证据提示（非失败）：${w}`);
        }
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        // 仅校验错误携带"修复反馈"重试（网络/超时等重试不需要修复提示，也避免把非校验错误误当提示）。
        // 反馈会点名具体非法条目（如"删除 newEntities 中的 杀戮舞曲"）；JSON 解析失败/截断同样回填，
        // 让 buildFixInstruction 给出针对性提示（禁前言文字/半角标点/精简输出）。
        feedback = e instanceof ValidationError
          ? buildValidationFeedback(rawOutput, lastError)
          : (lastError.includes("无法解析为 JSON") || lastError.includes("被截断") ? lastError : "");
        // 仅校验失败回传上一次输出（可用的完整 JSON）；解析失败/截断时上次输出不可用，不下发
        previousOutput = e instanceof ValidationError && rawOutput !== null && typeof rawOutput === "object"
          ? JSON.stringify(rawOutput)
          : undefined;
        if (attempt >= retries) break;
      }
    }
    const durationMs = Date.now() - t0;
    const success = bundle !== null;

    if (!bundle) {
      warn(`[${key}] 抽取失败（重试 ${retries} 次后放弃）：${lastError}`);
      repo.addLlmLog({ phase: "extract", model: provider.name, range: key, chars: batchChars, chapters: texts.length, inputTokens: usage.inputTokens, inputUncachedTokens: usage.inputTokens - usage.cachedTokens, outputTokens: usage.outputTokens, durationMs, success: false, retries: attempt, error: lastError });
      repo.markBatch(key, r.start, r.end, "failed", zeroCounts(), null);
      const br: BatchResult = { range: key, status: "failed", error: lastError, ...zeroCounts() };
      processed.push(br);
      running.splice(running.indexOf(key), 1);
      writeIndex(br, { usage: { input: usage.inputTokens, cached: usage.cachedTokens, output: usage.outputTokens }, chars: batchChars, durationMs, attempts: attempt + 1, summary: null, sessionLog: batchSessionLog?.path ?? null });
      emitProgress(key, "failed", br);
      return;
    }

    // ---- 入库（全同步，无 await，线程安全） ----
    const counts = { newEntities: 0, aliases: 0, facts: 0, relations: 0, abilities: 0, events: 0, memoryAnchors: 0, duplicates: 0 };
    let entityUpdates = 0;

    try {
      repo.db.exec("BEGIN");
      const createdThisBatch = new Set<string>();
      for (const e of bundle.newEntities) {
        const r1 = repo.upsertEntity(e.type as any, e.name, e.firstSeenChapter);
        if (r1.created) { counts.newEntities++; createdThisBatch.add(r1.id); }
        else entityUpdates++;
      }
      const ensureEntity = (name: string, chapter: number): string | null => {
        // 用【不过滤】的按名查找：Build 入库不受 Reader userChapter 边界影响，
        // 否则跨章节实体（first_seen_chapter > userChapter）会被误判为不存在而重复建实体
        const ex = repo.findEntityByNameRaw(name);
        if (ex) {
          repo.upsertEntity(ex.type, name, chapter);
          return ex.id;
        }
        const r1 = repo.upsertEntity("character", name, chapter);
        if (r1.created) { counts.newEntities++; createdThisBatch.add(r1.id); }
        return r1.id;
      };
      for (const a of bundle.aliases) {
        const id = ensureEntity(a.entityName, a.fromChapter);
        if (!id) continue;
        const status = repo.addAlias(id, a.alias, a.fromChapter);
        if (status === "added") counts.aliases++;
        else if (status === "clash") {
          const other = repo.findByAlias(a.alias);
          if (other) aliasClashToDuplicate(repo, a.alias, id, other.id);
        }
      }
      for (const f of bundle.facts) {
        const id = ensureEntity(f.entityName, f.chapter);
        if (id && repo.addFact(id, f.type, f.value, f.chapter, f.confidence)) counts.facts++;
      }
      for (const rel of bundle.relations) {
        const from = ensureEntity(rel.fromName, rel.chapter);
        const to = ensureEntity(rel.toName, rel.chapter);
        if (from && to && from !== to && repo.addRelation(from, to, rel.type, rel.detail, rel.chapter, rel.confidence)) counts.relations++;
      }
      for (const ab of bundle.abilities) {
        const id = ensureEntity(ab.entityName, ab.chapter);
        if (id && repo.addAbility(id, {
          name: ab.name, category: ab.category, system: ab.system, path: ab.path, level: ab.level,
          source_entity: ab.sourceEntity, acquired_chapter: ab.acquiredChapter, summary: ab.summary,
          chapter: ab.chapter, confidence: 0.85,
        })) counts.abilities++;
      }
      for (const e of bundle.events) {
        const partIds = e.participantNames.map((n) => ensureEntity(n, e.chapter)).filter(Boolean) as string[];
        if (repo.addEvent(e.chapter, partIds, e.type, e.summary, e.importance)) counts.events++;
      }
      for (const m of bundle.memoryAnchors) {
        const id = ensureEntity(m.entityName, m.chapter);
        if (id && repo.addMemoryAnchor(id, m.chapter, m.summary, m.importance, m.memorability, m.protagonistRelevance, m.kind)) counts.memoryAnchors++;
      }
      for (const d of bundle.possibleDuplicates) {
        const aId = repo.findEntityByName(d.entityA)?.id;
        const bId = repo.findEntityByName(d.entityB)?.id;
        if (aId && bId && aId !== bId) {
          const [low, high] = [aId, bId].sort();
          if (repo.addPossibleDuplicate(low, high, d.reason)) counts.duplicates++;
        }
      }
      for (const c of bundle.conflicts) {
        const eId = c.entityName ? repo.findEntityByName(c.entityName)?.id ?? null : null;
        repo.addConflict(c.kind, eId, c.detail, c.chapterA, c.chapterB);
      }
      countAppearances(repo, texts);
      repo.db.exec("COMMIT");
    } catch (e) {
      repo.db.exec("ROLLBACK");
      const msg = e instanceof Error ? e.message : String(e);
      warn(`[${key}] 入库失败（事务回滚）：${msg}`);
      repo.addLlmLog({ phase: "extract", model: provider.name, range: key, chars: batchChars, chapters: texts.length, inputTokens: usage.inputTokens, inputUncachedTokens: usage.inputTokens - usage.cachedTokens, outputTokens: usage.outputTokens, durationMs, success: false, retries: attempt, error: msg });
      repo.markBatch(key, r.start, r.end, "failed", zeroCounts(), null);
      const br: BatchResult = { range: key, status: "failed", error: msg, ...zeroCounts() };
      processed.push(br);
      running.splice(running.indexOf(key), 1);
      writeIndex(br, { usage: { input: usage.inputTokens, cached: usage.cachedTokens, output: usage.outputTokens }, chars: batchChars, durationMs, attempts: attempt + 1, summary: bundle?.batchSummary ?? null, sessionLog: batchSessionLog?.path ?? null });
      emitProgress(key, "failed", br);
      return;
    }

    const inputTokens = usage.inputTokens;      // 真实 usage（含缓存）
    const inputUncachedTokens = usage.inputTokens - usage.cachedTokens;
    const outputTokens = usage.outputTokens;
    repo.addLlmLog({ phase: "extract", model: provider.name, range: key, chars: batchChars, chapters: texts.length, inputTokens, inputUncachedTokens, outputTokens, durationMs, success: true, retries: attempt });
    repo.markBatch(key, r.start, r.end, "done", counts, bundle.batchSummary);

    log(`  new entities: ${counts.newEntities}`);
    if (entityUpdates > 0) log(`  entity updates: ${entityUpdates}`);
    if (counts.aliases) log(`  aliases: ${counts.aliases}`);
    if (counts.facts) log(`  facts: ${counts.facts}`);
    if (counts.relations) log(`  relations: ${counts.relations}`);
    if (counts.abilities) log(`  abilities: ${counts.abilities}`);
    if (counts.events) log(`  events: ${counts.events}`);
    if (counts.memoryAnchors) log(`  memory anchors: ${counts.memoryAnchors}`);
    if (counts.duplicates) log(`  possible duplicates: ${counts.duplicates}`);

    const br: BatchResult = { range: key, status: "done", ...counts, entityUpdates };
    processed.push(br);
    running.splice(running.indexOf(key), 1);
    // Evidence Grounding 可观测性：统计本批带 evidence 的 temporal 记录数与非致命 warning 数（不存原文）
    const evidenceValidated =
      bundle.facts.length + bundle.relations.length + bundle.memoryAnchors.length + bundle.aliases.length + bundle.abilities.length +
      bundle.events.filter((e) => e.evidence).length +
      bundle.newEntities.filter((e) => e.evidence).length;
    writeIndex(br, {
      usage: { input: usage.inputTokens, cached: usage.cachedTokens, output: usage.outputTokens },
      chars: batchChars, durationMs, attempts: attempt + 1,
      summary: bundle.batchSummary ?? null,
      sessionLog: batchSessionLog?.path ?? null,
      evidenceValidated,
      evidenceWarnings: bundle.warnings.length,
    });
    emitProgress(key, "done", br);
  }

  // ── 执行：严格串行（批间存在强依赖，禁止并发） ──
  // 依赖链：批 N+1 的抽取（search_existing_entities 检索 + 滚动摘要）依赖批 N 已入库的实体；
  //         滚动摘要（rollPreviousSummary）依赖前一批的 batchSummary；
  //         并行会让后一批看不到前一批刚创建的实体 → 重复建实体、摘要错乱。
  // 因此并发参数不再生效：批内仍可合并多章（同一 prompt 顺序阅读无依赖问题），
  // 但批与批之间必须按顺序逐批执行。
  const requestedConcurrency = Math.max(1, opts.concurrency ?? 1);
  if (requestedConcurrency > 1) {
    warn(`[build] 已忽略 --parallel ${requestedConcurrency}：批间存在实体/摘要依赖，必须串行执行以保证正确性。`);
  }
  // 数据库快照备份（默认关闭；--backup / opts.backup 开启）：在任何写入前生成一致性快照，
  // 为 --force 全量重跑提供可回滚点。VACUUM INTO 保证事务一致（含 WAL 已提交数据）。
  if (opts.backup && pending.length > 0) {
    const snap = backupDatabase(repo.db, { dir: join(".story", "backups") });
    log(`数据库备份：${snap.path}（${(snap.bytes / 1024).toFixed(0)} KB）`);
  }
  if (totalBatches === 0) {
    // 没有待处理批次，也上报一次空进度（UI 立即显示"无待处理"）
    opts.onProgress?.({ range: "", status: "done", counts: zeroResult("", "done"), doneCount: 0, totalCount: 0, failedCount: 0, doneChapters: 0, totalChapters: 0, running: [] });
  }
  // 失败即停（默认）：串行依赖下，某批重试后仍失败 → 后续批次不应继续，
  // 否则后续抽取会引用缺失实体产生悬空引用。--keep-going 显式允许继续。
  const failFast = opts.failFast ?? true;
  for (const r of pending) {
    if (opts.signal?.aborted) break; // 取消：不再开始新批次
    await processBatch(r);
    if (opts.signal?.aborted) break; // 当前批次刚结束即被取消
    if (failFast && processed.some((p) => p.status === "failed")) {
      const failedRange = processed.filter((p) => p.status === "failed").map((p) => p.range).join(", ");
      const remaining = pending.filter((x) => x !== r);
      warn(`[build] 批次（${failedRange}）失败后停止：批间存在实体/摘要依赖，未执行后续 ${remaining.length} 个批次（修复后重跑会自动续跑）。`);
      // 将未执行批次一并上报为"未处理"（status 保持 pending，UI 显示剩余）
      break;
    }
  }

  // ── 主线索引 run_end：本次构建汇总 ──
  const done = processed.filter((p) => p.status === "done").length;
  const failedCount = processed.filter((p) => p.status === "failed").length;
  mainline.write({
    kind: "run_end", runId,
    durationMs: Date.now() - runStart,
    batches: processed.length, done, failed: failedCount, skipped,
    aborted: opts.signal?.aborted ?? false,
    tokens: runTokens,
    chars: runChars,
  });

  return { processed, skipped, failed, runId };
}

function zeroCounts() {
  return { newEntities: 0, entityUpdates: 0, aliases: 0, facts: 0, relations: 0, abilities: 0, events: 0, memoryAnchors: 0, duplicates: 0 };
}

/** 取 startChapter 之前的最近一个已完成批次的摘要 */
function rollPreviousSummary(repo: StoryRepo, startChapter: number): string | null {
  const rows = repo
    .db
    .prepare("SELECT range, summary FROM batch_state WHERE status='done' AND end_chapter < ? ORDER BY end_chapter DESC LIMIT 1")
    .all(startChapter) as { range: string; summary: string | null }[];
  return rows.length ? rows[0].summary : null;
}

/** 出场记录：对给定章节文本扫描所有实体名+别名 */
export function countAppearances(repo: StoryRepo, texts: ChapterSlice[]): void {
  const entities = repo.listEntities();
  const aliasMap = new Map<string, string>(); // alias → entityId
  for (const a of repo.listAliases()) aliasMap.set(a.alias, a.entity_id);
  for (const t of texts) {
    for (const e of entities) {
      let mentions = 0;
      mentions += countOccurrences(t.text, e.name);
      for (const [alias, eid] of aliasMap) {
        if (eid === e.id) mentions += countOccurrences(t.text, alias);
      }
      if (mentions > 0) repo.recordAppearance(e.id, t.chapter, mentions);
    }
  }
}

function countOccurrences(text: string, needle: string): number {
  if (!needle || needle.length === 0) return 0;
  let n = 0;
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    n++;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return n;
}