// TUI 斜杠命令处理器：/build, /import, /status, /review, /audit, /settings, /login, /logout
// 像 Claude Code 一样，在输入框输入 /xxx 执行运维操作；命令名/说明由 SLASH_COMMANDS 驱动 `/` 自动补全

import { StoryRepo } from "../../db/repo.js";
import { StoryConfig, saveConfig } from "../../config.js";
import { LlmProvider } from "../../llm/types.js";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { SlashCommand } from "@earendil-works/pi-tui";
import { clearLlmConnection, type BuildPanelHandle } from "./menus.js";

/** TUI 界面化命令能力（/settings、/login 由 app.ts 注入，负责弹出交互式覆盖层） */
export interface TuiUi {
  openSettings(): void;
  openLogin(): void;
  /** LLM 配置变更后重建 provider/agent（/login 保存 / /logout 后调用，实时生效） */
  reloadLlm?: () => Promise<{ ok: boolean; error?: string; mode?: "llm" }>;
  /** /build：打开构建面板（返回控制器；Esc 触发 onCancel 取消构建） */
  openBuild?: (hooks: { onCancel: () => void }) => BuildPanelHandle;
}

export interface CommandContext {
  repo: StoryRepo;
  cfg: StoryConfig;
  provider: LlmProvider | null;
  /** 当前章节焦点（与 Agent 工具共享引用，/chapter 切换时可清理） */
  focus?: { from: number | null; to: number | null };
  /** 工具上下文可变引用（/chapter 切换时同步 userChapter，使 get_progress 返回新值） */
  toolCtx?: { userChapter: number; focus: { from: number | null; to: number | null } };
  /** Agent 实例（/chapter 切换章节时 reset 清空消息历史，防止旧数据泄露；未配置 LLM 时为 null/undefined） */
  agent?: Agent | null;
  /** 进度回调（build 等长任务每批完成时触发，TUI 实时更新） */
  onProgress?: (text: string) => void;
  /** 向聊天区输出（如 build 完成后把完整结果输出到可滚动的聊天记录） */
  onNotify?: (text: string) => void;
  /** 界面化命令（/settings /login） */
  ui?: TuiUi;
}

export interface CommandResult {
  text: string;
  suggestReload?: boolean;
  /** 建议清空聊天界面（章节切换后清空历史防止泄露） */
  suggestClear?: boolean;
  /** UI 命令（/settings /login）：不在聊天区回显命令与结果 */
  noEcho?: boolean;
}

/** UI 命令：打开全屏/局部面板，不产生聊天痕迹 */
export const UI_COMMANDS: ReadonlySet<string> = new Set(["settings", "login", "build"]);

/** 命令注册表：name/description 用于 pi-tui 输入 `/` 时的补全菜单 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "status", description: "工作区状态：数据量/成本/构建性能/进度/完整性校验" },
  { name: "settings", description: "交互式设置菜单（↑/↓ + Enter/Space 修改）" },
  { name: "login", description: "引导式配置 LLM 连接（baseUrl → apiKey → model → 测试）" },
  { name: "logout", description: "清除已保存的 LLM 连接凭据（baseUrl/apiKey/model）" },
  { name: "chapter", description: "查看/切换当前阅读进度（Ask 防剧透边界）", argumentHint: "<章节号>" },
  { name: "build", description: "构建知识库（Agent 化抽取，失败即停）", argumentHint: "[--from N] [--to N] [--force] [--backup] [--batch-size N] [--auto-batch] [--keep-going]" },
  { name: "import", description: "导入小说文件（会清空现有数据）", argumentHint: "<文件路径>" },
  { name: "review", description: "审核疑似重复/低置信度数据", argumentHint: "[--auto]" },
  { name: "audit", description: "防剧透审计" },
  { name: "clear", description: "清空聊天历史" },
  { name: "exit", description: "退出" },
];

/** 临时捕获 console 输出，返回给 Agent 作为工具结果（避免污染 TUI/终端） */
async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  try {
    const result = await fn();
    return { result, output: chunks.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

function parseArgs(input: string): { cmd: string; flags: Record<string, string | boolean | number>; positional: string[] } {
  const parts = input.trim().split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase().replace(/^\//, "");
  const flags: Record<string, string | boolean | number> = {};
  const positional: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("--")) {
      const eq = p.indexOf("=");
      if (eq >= 0) {
        const val = parseFlagValue(p.slice(eq + 1));
        flags[p.slice(0, eq)] = val;
      } else if (i + 1 < parts.length && !parts[i + 1].startsWith("--")) {
        flags[p] = parseFlagValue(parts[i + 1]);
        i++;
      } else {
        flags[p] = true;
      }
    } else {
      positional.push(p);
    }
  }
  return { cmd, flags, positional };
}

function parseFlagValue(v: string): string | boolean | number {
  if (v === "true" || v === "false") return v === "true";
  const n = Number(v);
  if (!Number.isNaN(n) && String(n) === v) return n;
  return v;
}

export async function runSlashCommand(input: string, ctx: CommandContext): Promise<CommandResult | null> {
  const { cmd, flags, positional } = parseArgs(input);
  const { repo, cfg, provider } = ctx;

  switch (cmd) {
    // ── 工作区状态（合并原 /context /stats /progress /validate） ──
    case "status": {
      const chapters = repo.countChapters();
      const availableThrough = repo.availableThrough() ?? 0;
      const builtThrough = repo.builtThrough();
      const focus = (ctx as any).focus ?? null;
      const focusLine = focus?.from != null
        ? `章节焦点：第 ${focus.from} ～ ${focus.to} 章`
        : "章节焦点：无（检索全部章节）";
      // 最近 5 章（在 userChapter 范围内）
      const recentChapters = repo.listChapterMeta().slice(-5);
      const recentLine = recentChapters.length
        ? `最近 5 章：${recentChapters.map((m) => `第 ${m.chapter} 章 ${m.title}`).join("、")}`
        : "最近 5 章：无";

      const lines = [`## 工作区状态：${cfg.book || "（未导入）"}`, ""];

      // ── 上下文 ──
      lines.push("### 上下文");
      lines.push(`- 已导入章节：${chapters}（availableThrough = ${availableThrough}）`);
      lines.push(`- 已构建章节：${builtThrough ?? 0}（builtThrough）`);
      lines.push(`- 当前阅读进度：**第 ${cfg.userChapter} 章**（/chapter 切换）`);
      lines.push(`- ${focusLine}`);
      lines.push(`- ${recentLine}`);
      lines.push(`- **LLM ${provider ? "已配置" : "未配置"}**${provider ? "" : "（可用 `/login` 配置，保存后重启 TUI 生效）"}`);

      // ── 处理进度 ──
      lines.push("");
      lines.push("### 处理进度");
      const batches = repo.listBatches(); // [{range: "1-5", status: "done"|"failed"}]
      const doneChapters = new Set<number>();
      const failedChapters = new Set<number>();
      for (const b of batches) {
        const [s, e] = b.range.split("-").map(Number);
        if (isNaN(s) || isNaN(e)) continue;
        for (let ch = s; ch <= e; ch++) {
          if (b.status === "done") doneChapters.add(ch);
          else failedChapters.add(ch);
        }
      }
      // 失败统计不包含已被 done 批次覆盖的章节（如旧失败批与后来逐章成功批重叠）
      for (const ch of [...failedChapters]) if (doneChapters.has(ch)) failedChapters.delete(ch);
      const done = doneChapters.size;
      const failed = failedChapters.size;
      const pct = availableThrough > 0 ? Math.round((done / availableThrough) * 100) : 0;
      const barWidth = 30;
      const filled = Math.round((pct / 100) * barWidth);
      const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
      lines.push(`\`${bar}\` **${pct}%**（${done}/${availableThrough} 章）`);
      if (failed > 0) lines.push(`> ⚠️ ${failed} 章失败（可用 \`/build\` 自动重试）`);
      // 未处理区间（连续未 done 的章节）
      const unprocessedRanges: string[] = [];
      let rangeStart: number | null = null;
      for (let ch = 1; ch <= availableThrough; ch++) {
        if (!doneChapters.has(ch)) {
          if (rangeStart === null) rangeStart = ch;
        } else {
          if (rangeStart !== null) {
            unprocessedRanges.push(rangeStart === ch - 1 ? `第 ${rangeStart} 章` : `第 ${rangeStart}～${ch - 1} 章`);
            rangeStart = null;
          }
        }
      }
      if (rangeStart !== null) unprocessedRanges.push(rangeStart === availableThrough ? `第 ${availableThrough} 章` : `第 ${rangeStart}～${availableThrough} 章`);
      if (unprocessedRanges.length === 0) {
        lines.push("✅ **全部章节已处理完成！**");
      } else {
        lines.push("**未处理/待重跑：**");
        for (const r of unprocessedRanges) lines.push(`- ${r}`);
      }

      // ── 数据 & 成本 & 性能 & 完整性（复用 cmdStats，含退出码） ──
      lines.push("");
      lines.push("### 数据 & 成本 & 性能 & 完整性");
      const { cmdStats } = await import("../commands/stats.js");
      const { result, output } = await captureConsole(() => cmdStats());
      lines.push("```");
      lines.push(output.trim());
      lines.push("```");
      lines.push(result === 0 ? "✅ 完整性通过（无严重错误）" : "❌ 完整性存在严重错误");
      return { text: lines.join("\n") };
    }

    // ── 切换阅读进度 ──
    case "chapter": {
      const nArg = positional[0] || (typeof flags["--set"] === "number" ? flags["--set"] as number : null);
      if (nArg === null) {
        return { text: `当前阅读进度：**第 ${cfg.userChapter} 章**。\n\n用法：\`/chapter <章节号>\` 设置，所有检索只返回 ≤ 该章的数据。\n例如：\`/chapter 433\` 表示读到第 433 章。` };
      }
      const n = typeof nArg === "number" ? nArg : parseInt(String(nArg), 10);
      if (!Number.isInteger(n) || n < 1) {
        return { text: `无效章节号：${nArg}，请输入正整数。` };
      }
      // 上限 = 已导入章节数（availableThrough），不是配置
      const max = repo.availableThrough() ?? 0;
      if (max > 0 && n > max) {
        return { text: `章节号 ${n} 超过已导入的最大章节 ${max}（可用 story import 导入更多章节）。` };
      }
      // 更新 config
      cfg.userChapter = n;
      const { saveConfig } = await import("../../config.js");
      saveConfig(cfg);
      // 更新 repo 过滤边界 — 实时生效（repo 是同一引用）
      repo.setUserChapter(n);
      // 更新工具上下文 userChapter（使 agent 的 get_progress 工具返回新值）
      if (ctx.toolCtx) ctx.toolCtx.userChapter = n;
      // 清空 Agent 消息历史 — 防止之前章节看到的数据（如第 300 章时的完整别名）通过历史泄露
      if (ctx.agent) {
        ctx.agent.reset();
      }
      // 如果焦点超出新边界，清理焦点（原地修改，保持与 Agent 工具共享的引用）
      if (ctx.focus && ctx.focus.to !== null && ctx.focus.to > n) {
        ctx.focus.from = null;
        ctx.focus.to = null;
      }
      return { text: `✅ 阅读进度已切换为 **第 ${n} 章**（对话已重置，之前的上下文已清除）。\n\n之后所有检索只返回 ≤ 第 ${n} 章的数据。\n> 当前工作区过滤边界：${repo.userChapter} 章（${n < max ? `收窄，仅 ${n} 章前数据可见` : '全量数据可见'}）\n> 注意：这不会影响已构建的结构化数据，只是 Ask 检索的过滤边界。`, suggestClear: true };
    }

    // ── 构建知识库（独立面板：进度实时显示，构建中不能干别的，Esc 取消） ──
    case "build": {
      if (!provider) {
        return { text: "未配置 LLM，无法执行构建。请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（可写入 .env 文件）。" };
      }
      const chapters = repo.countChapters();
      if (chapters === 0) {
        return { text: "chapters 为空，请先 `/import` 导入小说文件。" };
      }
      const { runBuild } = await import("../../build/pipeline.js");

      // 打开构建面板；面板 Esc → 取消（pipeline 的 signal 批间检查）
      const controller = new AbortController();
      const handle = ctx.ui?.openBuild
        ? ctx.ui.openBuild({ onCancel: () => controller.abort() })
        : null;
      const renderTarget = (text: string): void => {
        if (handle) handle.render(text);
        else ctx.onProgress?.(text); // 无面板时的兜底（聊天流式）
      };
      // 本次构建的 token 累计基线（llm_logs 快照，进度里显示差量）
      const startMetrics = repo.buildMetrics("extract", 1_000_000);

      // 进度回调：每批开始/完成时更新面板
      const onProgress = (p: import("../../build/pipeline.js").BuildProgress): void => {
        const pct = p.totalChapters > 0 ? Math.round((p.doneChapters / p.totalChapters) * 100) : 0;
        // 进度条长度随面板/终端宽度自适应（markdown 内容宽度 ≈ 面板宽 - 尾部文本）
        const panelWidth = handle && handle.width() > 0 ? handle.width() : 0;
        const barWidth = panelWidth > 0 ? Math.max(10, Math.min(panelWidth - 26, 80)) : 20;
        const filled = Math.round((pct / 100) * barWidth);
        const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

        // ETA：基于历史真实的抽取速率（字符/秒）推算剩余章节
        let eta = "";
        try {
          const bm = repo.buildMetrics("extract");
          if (bm.calls > 0 && bm.durationMs > 0 && bm.chapters > 0 && p.totalChapters > p.doneChapters) {
            const charsPerSec = (bm.chars / bm.durationMs) * 1000;
            const avgCharsPerChapter = bm.chars / bm.chapters;
            const remaining = p.totalChapters - p.doneChapters;
            const etaSec = (remaining * avgCharsPerChapter) / charsPerSec;
            if (etaSec > 0) eta = `（预计剩余 ${formatDuration(etaSec)}）`;
          }
        } catch { /* 指标不可用时静默 */ }

        // 实时 token 消耗（本次构建差量；llm_logs 随每批写入，进度每次刷新读取）
        const m = repo.buildMetrics("extract", 1_000_000);
        const tokIn = Math.max(0, m.inputTokens - startMetrics.inputTokens);
        const tokOut = Math.max(0, m.outputTokens - startMetrics.outputTokens);

        const lines = [`## 🔨 构建中`, ``];
        if (p.totalChapters === 0) {
          lines.push("无待处理章节（全部已完成？可用 `--force` 强制重跑）");
        } else {
          lines.push(`\`${bar}\` **${pct}%**`);
        }
        if (p.failedCount > 0) lines.push(`> ⚠️ ${p.failedCount} 批失败`);
        // token 消耗与 ETA 同一行（ETA 拼在末尾）
        // token 消耗 + ETA + 正在处理 同一行（正在处理跟在 ETA 之后）
        const runningInfo = p.running.length > 0
          ? ` · 正在处理：${p.running.map((r) => `[${fmtRange(r)}]`).join(" ")} ⏳`
          : "";
        lines.push(`> ⚡ 累计消耗：输入 ${tokIn.toLocaleString()} · 输出 ${tokOut.toLocaleString()} token${eta}${runningInfo}`);
        lines.push("");
        // 当前批次运行日志（agent 活动：调用工具 / 生成 JSON 等），避免干等
        if (p.running.length > 0 && p.statusLine) {
          lines.push(`> ${p.statusLine}`);
          lines.push("");
        }
        renderTarget(lines.join("\n"));
      };

      // 结束：面板显示简洁版（避免长表格溢出无法滚动），完整结果输出到可滚动的聊天区
      const finish = (summary: string, panelText?: string): { text: string; noEcho?: boolean } => {
        renderTarget(panelText ?? summary);
        ctx.onNotify?.(summary); // 完整结果（含批次表格）进聊天区，可滚动查看、关闭面板后仍有记录
        if (handle) {
          handle.markDone();
          // onSubmit 末尾会 setFocus(editor) 抢焦点；延迟把焦点还给面板，让 Esc 能关闭
          setTimeout(() => handle.focus(), 0);
          return { noEcho: true, text: "" };
        }
        return { text: summary };
      };

      try {
        const { result } = await captureConsole(() =>
          runBuild(repo, provider, {
            fromChapter: typeof flags["--from"] === "number" ? flags["--from"] as number : undefined,
            toChapter: typeof flags["--to"] === "number" ? flags["--to"] as number : undefined,
            force: flags["--force"] === true,
            // 数据库快照备份（默认关闭；--backup 开启），与 CLI --backup 对齐
            backup: flags["--backup"] === true,
            batchSize: typeof flags["--batch-size"] === "number"
              ? flags["--batch-size"] as number
              : (cfg.build?.batchSize ?? undefined),
            concurrency: 1,
            autoBatch: flags["--auto-batch"] === true || (flags["--batch-size"] !== undefined ? false : (cfg.build?.autoBatch ?? true)),
            failFast: !(flags["--keep-going"] === true),
            // 与 CLI 对齐：重试次数读 config.build.retries（/settings 可改），否则 TUI /build 永远用默认 2
            retries: cfg.build?.retries,
            sessionLog: cfg.build?.sessionLog ?? true,
            maxBatchChapters: cfg.build?.maxBatchChapters,
            perChapterOutputTokens: cfg.build?.perChapterOutputTokens,
            onProgress,
            signal: controller.signal,
          })
        );
        if (controller.signal.aborted) {
          return finish(`## ⏹ 构建已取消\n\n已处理 ${result.processed.length} 批（取消后不再开始新批次，重跑自动续跑）。`);
        }
        const summary = [`## Build 完成`];
        const done = result.processed.filter((b) => b.status === "done");
        const failed = result.processed.filter((b) => b.status !== "done");
        const headLine = `处理 ${result.processed.length} 批，跳过 ${result.skipped} 批，失败 ${failed.length} 批。`;
        summary.push(headLine);
        if (done.length > 0) {
          summary.push("");
          summary.push("### 成功批次");
          summary.push("| 区间 | 实体 | 别名 | 事实 | 关系 | 能力 | 事件 | 锚点 |");
          summary.push("|------|------|------|------|------|------|------|------|");
          for (const b of done) {
            summary.push(`| ${b.range} | +${b.newEntities} | ${b.aliases} | ${b.facts} | ${b.relations} | ${b.abilities} | ${b.events} | ${b.memoryAnchors} |`);
          }
        }
        if (failed.length > 0) {
          summary.push("");
          summary.push("### 失败批次");
          for (const b of failed) summary.push(`- ${b.range} ❌${b.error ? `（${b.error}）` : ""}`);
          summary.push("\n可用 `/build --force` 重跑失败区间。");
        }
        if (result.skipped > 0) {
          summary.push(`\n> 已跳过 ${result.skipped} 个已完成批次（使用 \`--force\` 可强制重跑）`);
        }
        summary.push(`\n> 索引日志：\`.story/logs/build/mainline.jsonl\`（runId=\`${result.runId}\`，每批一行可回溯）`);
        // 面板显示简洁版（避免长表格溢出），完整结果进聊天区可滚动查看
        const panelText = [
          `## Build 完成`,
          headLine,
          failed.length > 0 ? `> ⚠️ ${failed.length} 批失败，详见聊天区完整明细` : "",
          "> 完整批次明细已输出到聊天区（可滚动查看）。",
        ].filter(Boolean).join("\n");
        return finish(summary.join("\n"), panelText);
      } catch (e: any) {
        return finish(`## ❌ 构建失败\n\n${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // ── 导入小说 ──
    case "import": {
      const path = positional[0] || (typeof flags["--path"] === "string" ? flags["--path"] : "");
      if (!path) {
        return { text: "用法：`/import <小说文件路径>` 或 `/import --path=<路径>`" };
      }
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const absPath = existsSync(path) ? path : join(process.cwd(), path);
      if (!existsSync(absPath)) {
        return { text: `文件不存在：${path}` };
      }
      const { cmdImport } = await import("../commands/import.js");
      const { result, output } = await captureConsole(() =>
        cmdImport({
          path: absPath,
        })
      );
      const lines = [
        "## 导入结果",
        `exit code: ${result}`,
        "",
        "```",
        output.trim().slice(0, 2000),
        "```",
        "",
        "> ⚠️ 数据已更新，建议重新进入 TUI 以加载最新数据。",
      ];
      return {
        text: lines.join("\n"),
        suggestReload: true,
      };
    }

    // ── 审核 ──
    case "review": {
      const { cmdReview } = await import("../commands/review.js");
      const revFlags: Record<string, string | boolean> = {};
      if (flags["--auto"]) revFlags["--auto"] = true;
      const { result, output } = await captureConsole(() => cmdReview(revFlags));
      const status = result === 0 ? "✅ 无待审核项" : `⚠️ exit=${result}`;
      const lines = [
        "## 审核",
        `**结果：** ${status}`,
        "",
        "```",
        output.trim().slice(0, 2000),
        "```",
      ];
      return { text: lines.join("\n") };
    }

    // ── 防剧透审计 ──
    case "audit": {
      const { cmdAudit } = await import("../commands/audit.js");
      const { result, output } = await captureConsole(() => cmdAudit());
      const status = result === 0 ? "✅ 无越界" : "❌ 发现越界章节";
      const lines = [
        "## 防剧透审计",
        `**结果：** ${status}`,
        "",
        "```",
        output.trim(),
        "```",
      ];
      return { text: lines.join("\n") };
    }

    // ── 界面化：交互式设置菜单（pi code agent 风格，Esc 关闭） ──
    case "settings": {
      ctx.ui?.openSettings();
      return { noEcho: true, text: "" };
    }

    // ── 界面化：引导式 LLM 连接向导 ──
    case "login": {
      ctx.ui?.openLogin();
      return { noEcho: true, text: "" };
    }

    // ── 登出：清除已保存的 LLM 连接凭据 ──
    case "logout": {
      const had = clearLlmConnection(cfg);
      saveConfig(cfg);
      const r = ctx.ui?.reloadLlm ? await ctx.ui.reloadLlm() : undefined;
      const note = had
        ? (r
          ? (r.ok
            ? "> ✅ 已实时生效：连接已清除，当前为「未配置」状态（Ask/Build 需先 /login）。"
            : `> ❌ 已清除但重建失败：${r.error ?? "未知错误"}（下次启动时按新配置生效）。`)
          : "> 已清除（需重启 TUI 后按新配置重建）。")
        : "";
      return {
        text: had
          ? `## 已登出\n已清除 \`.story/config.json\` 中保存的 LLM 连接凭据（baseUrl / apiKey / model）。\n\n${note}\n> 环境变量（\`LLM_BASE_URL\` 等）不受影响，仍会生效。`
          : "## 登出\n当前没有已保存的 LLM 连接凭据（如已通过环境变量 `LLM_API_KEY` 等配置，仍会生效）。",
      };
    }

    // ── 未知命令 ──
    default:
      return null;
  }
}

/** 命令列表提示（用于未知命令；命令清单由 `/` 自动补全展示） */
export function commandHint(): string {
  return "输入 `/` 可查看并补全所有可用命令（status / settings / login / logout / chapter / build / import / review / audit / clear / exit）。";
}

/** 批次区间格式化："38-38" → "第 38 章"；"1-26" → "第 1~26 章" */
function fmtRange(range: string): string {
  const [a, b] = range.split("-").map(Number);
  if (Number.isInteger(a) && Number.isInteger(b)) {
    return a === b ? `第 ${a} 章` : `第 ${a}~${b} 章`;
  }
  return range;
}

/** 时长格式化：秒 → "2.3 小时" / "45 分钟" / "30 秒" */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 小时`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} 分钟`;
  return `${Math.round(seconds)} 秒`;
}