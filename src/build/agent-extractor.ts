// Build 阶段的 Agent 化抽取器：基于 pi-agent-core 的 Agent + 工具调用驱动。
//
// 与 Ask（检索问答）不同，这里的 Agent 是"抽取器"：读章节文本 → 产出结构化数据。
// 关键区别：不再把"全量已存在实体清单"注入 prompt（长书后期会吃掉上下文、且 LLM 也
// 记不住），而是给 Agent 一个 search_existing_entities 工具，由 LLM 自己决定何时检索、
// 检索哪些名字（旧角色回归时），用返回的 entityId 复用，避免重复创建实体。
//
// 依赖：provider.getAgentKit() 提供 pi-ai 的 model + streamFn（pi-agent-core Agent 的底座）。

import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { StoryRepo } from "../db/repo.js";
import { LlmProvider, ExtractionInput, ExtractionResult } from "../llm/types.js";
import { extractJson } from "../llm/openai.js";
import { EXTRACTION_SYSTEM_PROMPT, buildFixInstruction } from "./prompts.js";
import { normalizeEvidenceText, isExtractionRootObject } from "./validation.js";
import type { BuildSessionLogger } from "./session-log.js";
import type { NovelTool } from "../reader/tools.js";
import { log, warn } from "../logger.js";

/** 从 pi-ai 的 content 块（thinking + text）中提取纯文本（会话日志用） */
function contentBlocks(blocks: { type: string; text?: string }[]): string {
  return (blocks ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

/** 单次批量检索的名字上限 */
const MAX_QUERY_NAMES = 40;

/**
 * Agent 化抽取：完整跑一轮 pi-agent-core Agent 循环（含工具调用），
 * 返回结构化 bundle + 累计 usage。输出无法解析为 JSON 时抛错（由 pipeline 重试）。
 */
export async function agentExtract(
  provider: LlmProvider,
  repo: StoryRepo,
  input: ExtractionInput,
  callbacks?: {
    onActivity?: (line: string) => void;
    /** 会话日志器：记录每个 turn/工具调用的完整轨迹（性能与准确度分析用） */
    sessionLog?: import("./session-log.js").BuildSessionLogger;
  }
): Promise<ExtractionResult> {
  const kit = provider.getAgentKit?.();
  if (!kit) {
    throw new Error("当前 provider 不支持 Agent 化抽取（缺少 getAgentKit）");
  }
  const { model, streamFn } = kit;
  const onActivity = callbacks?.onActivity;
  const sessionLog = callbacks?.sessionLog;

  // 系统提示词【跨批完全静态】（批次起止范围只出现在用户消息的「待抽取章节」里）：
// 前缀缓存（deepseek 对相同前缀命中 cacheRead，50x 便宜且 prefill 更快）因此可跨批次复用。
const systemPrompt = `${EXTRACTION_SYSTEM_PROMPT}

## Agent 工作流程（必须遵守）
1. 通读「待抽取章节」（起止章号见用户消息中的「待抽取章节」标题）。
2. 若文中出现的人物/组织可能【已在知识库中】存在（主角、常驻配角、已有组织等旧实体），
   调用工具 search_existing_entities 批量检索。工具返回结果的 name 是 canonical name（正式名）。
3. 【实体引用契约】命中已有实体后，最终 JSON 必须使用工具返回的 canonical name 作为 entityName/fromName/toName，
   不要使用当前文本中的别名再次创建实体（工具已通过别名定位到该实体）。
4. 未命中检索的旧名字、以及真正第一次登场的新名字，一律作为新实体处理（newEntities 用 name 给出）。
5. 【Evidence Grounding】每条 temporal 记录（chapter/fromChapter/firstSeenChapter）都要给出 evidence（原文短引）。
   evidence 直接从你已读到的章节原文摘取即可；只有当你记不清某句出自哪一章、或要确认"最早"章节时，
   才调用一次 search_chapter_evidence 检索——不要对每条记录都调用。
6. 最后严格输出唯一一个 JSON 对象（格式见上）。除 JSON 输出或工具调用外，
   不要输出任何其他文字——禁止解释/思考/检索过程描述（中英文都不行），不要用 markdown 代码块围栏，
   结构标点必须用半角（, : { } [ ] "），避免中文全角标点（，：）。`;

  // 章节文本（与 Ask 不同：build 阶段可读取原文）
  const chapters = input.texts
    .map((t) => `【第${t.chapter}章 ${t.title}】\n${t.text}`)
    .join("\n\n");

  // 校验失败重试：把具体错误 + 定向提示注入本次输出（buildFixInstruction 与 pipeline 校验共用）
  const fixBlock = input.feedback ? buildFixInstruction(input.feedback) + "\n\n" : "";

  // 上一次输出回传（ValidationError 重试）：让模型在上次基础上【只修被点名记录】，其余内容保持一致——
  // 避免重试从头重生成整份 JSON 而把其他本来正确的记录改坏（打地鼠问题的根治）。
  // 必须强调"完整写出"：模型容易把未修改的记录省略成 [...]/「同上」占位，导致整份不是合法 JSON。
  const previousBlock = input.previousOutput
    ? `\n## 你上一次的完整输出（除校验器点名的记录外，其余内容均正确）\n请【只修改校验器点名的记录】，其余记录的内容保持正确、不要改坏。\n【硬性】必须输出【完整】的 JSON：每条记录（包括未修改的记录）都要把实际内容完整写出，绝对禁止用 [...]、{...}、"同上/同前/其余不变/same as above" 等省略或占位写法代替任何记录——校验器会解析整份 JSON。\n上次输出：\n${input.previousOutput}\n\n`
    : "";

  const userMessage = `${fixBlock}${previousBlock}## 此前剧情摘要（供上下文理解，来自上一批抽取）
${input.previousSummary || "（无）"}

## 待抽取章节（第 ${input.startChapter}~${input.endChapter} 章）
${chapters}

请按系统要求开始：先判断是否需要调用 search_existing_entities，然后输出结构化 JSON。`;

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: model as any,
      tools: [
        {
          name: "search_existing_entities",
          label: "检索已有实体",
          description:
            "批量检索知识库中已存在的实体。传入章节文本中出现的、你可能想复用的名字（正式名/别名/固定称呼），返回命中实体的 id/name/type、别名，以及 facts/anchors 数量（用于判断该实体数据是否稀疏、是否需要补充 MemoryAnchor）。返回结果中的 name 是 canonical name（正式名）：最终 JSON 必须使用该 canonical name 作为 entityName/fromName/toName，避免用别名创建重复实体。",
          parameters: Type.Object({
            names: Type.Array(Type.String({ description: "待检索的名字列表（最多 40 个）" }), {
              maxItems: MAX_QUERY_NAMES,
              minItems: 1,
            }),
          }),
          execute: async (_id: string, params: any) => {
            const seen = new Set<string>();
            const hits: { id: string; name: string; type: string; aliases: string[]; facts: number; anchors: number }[] = [];
            for (const raw of (params as { names?: string[] }).names ?? []) {
              const name = raw.trim();
              if (!name || seen.has(name) || hits.length >= 100) continue;
              seen.add(name);
              const e = repo.findEntityByName(name) ?? repo.findByAlias(name);
              if (e) {
                hits.push({
                  id: e.id,
                  name: e.name,
                  type: e.type,
                  aliases: repo.listAliases(e.id).slice(0, 10).map((a) => a.alias),
                  // 数据密度：让模型判断该实体"已有什么、缺什么"——
                  // 若 facts/anchors 很少，本批出现的鲜明识别线索应补上（尤其 MemoryAnchor），
                  // 避免"绝不重复已有内容"的规则误伤稀疏实体的 Recall 数据
                  facts: repo.listFacts(e.id).length,
                  anchors: repo.listMemoryAnchors(e.id).length,
                });
              }
            }
            return {
              content: [
                {
                  type: "text",
                  text: hits.length
                    ? JSON.stringify(hits)
                    : "未命中任何已有实体：传入的名字可能都是新实体，直接作为新实体处理即可。",
                },
              ],
              details: { count: hits.length },
            };
          },
        },
        {
          name: "search_chapter_evidence",
          label: "检索章节原文证据",
          description:
            "在当前 Batch 章节原文中检索某个原文短语，返回它出现在哪些章节及上下文片段。用途：在输出最终 JSON 前，确认某条知识的 evidence（原文短引）到底出现在哪一章，从而正确填写 chapter（Reveal Chapter）与 evidence。这是 Build 专用工具，Ask/Reader 永远不会使用。",
          parameters: Type.Object({
            query: Type.String({ description: "要在章节原文中检索的短语，尽量是原文原句（如「老三闻人佑」「老三会做饭」「学【念】」）" }),
            maxResults: Type.Optional(Type.Integer({ description: "最多返回的章节数，默认 10" })),
          }),
          execute: async (_id: string, params: any) => {
            const q = params.query?.trim() ?? "";
            if (!q) return { content: [{ type: "text", text: "查询为空。" }], details: { count: 0 } };
            const nq = normalizeEvidenceText(q);
            const max = Math.min(Math.max(params.maxResults ?? 10, 1), 50);
            const results: { chapter: number; snippet: string }[] = [];
            for (const t of input.texts) {
              if (normalizeEvidenceText(t.text).includes(nq)) {
                // 在原文里定位片段：优先按原文原句定位；找不到则回退取开头
                const rawIdx = t.text.indexOf(q);
                const snippet =
                  rawIdx !== -1
                    ? t.text.slice(Math.max(0, rawIdx - 15), Math.min(t.text.length, rawIdx + q.length + 30)).replace(/\s+/g, " ")
                    : t.text.slice(0, 60).replace(/\s+/g, " ");
                results.push({ chapter: t.chapter, snippet });
              }
            }
            return {
              content: [
                {
                  type: "text",
                  text: results.length
                    ? JSON.stringify(results.slice(0, max))
                    : `当前 Batch（第 ${input.startChapter}~${input.endChapter} 章）原文中未找到「${q}」。请换用更贴近原文的短语，或确认该信息确实在本批出现。`,
                },
              ],
              details: { count: results.length },
            };
          },
        },
      ],
    },
    streamFn: streamFn as any,
    toolExecution: "sequential",
  });

  // 收集最终文本与真实 usage（多轮工具循环需要累加）
  let finalText = "";
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let generatedChars = 0;
  let textStarted = false;
  let turnCount = 0;
  let toolStartAt = 0;
  let toolCalls = 0;
  let lastStopReason = "";
  agent.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      finalText += event.assistantMessageEvent.delta ?? "";
      generatedChars += (event.assistantMessageEvent.delta ?? "").length;
      if (!textStarted) {
        textStarted = true;
        onActivity?.("模型正在生成结构化 JSON...");
      } else if (onActivity && generatedChars % 200 < 20) {
        // 节流：每约 200 字符更新一次进度
        onActivity?.(`模型生成中...（已 ${generatedChars} 字符）`);
      }
    }
    if (event.type === "tool_execution_start") {
      toolCalls++;
      const args = JSON.stringify(event.args ?? {});
      toolStartAt = Date.now();
      onActivity?.(`调用工具 ${event.toolName}(${args.slice(0, 120)}...)`);
      sessionLog?.write({
        t: "tool_call_start", range: input.range,
        tool: event.toolName, args: event.args ?? {}, turn: turnCount,
      });
    }
    if (event.type === "tool_execution_end") {
      const isError = (event as any).isError;
      const summary = isError
        ? "执行失败"
        : `完成（命中 ${((event.result as any)?.details?.count ?? "?")} 个实体）`;
      onActivity?.(`工具 ${event.toolName} ${summary}`);
      const resultText = (event.result as any)?.content?.[0]?.text;
      sessionLog?.write({
        t: "tool_call_end", range: input.range,
        tool: event.toolName, error: isError ?? false,
        result: typeof resultText === "string" ? resultText.slice(0, 2000) : resultText,
        durationMs: Date.now() - toolStartAt, turn: turnCount,
      });
    }
    if (event.type === "agent_end") {
      onActivity?.("Agent 完成，正在解析结构化结果...");
    }
    if (event.type === "message_end" && event.message) {
      const msg = event.message as any;
      lastStopReason = msg.stopReason ?? lastStopReason;
      const u = msg.usage;
      const turnInput = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
      const turnOutput = (u?.output ?? 0) + (u?.reasoning ?? 0);
      const msgText = contentBlocks(msg.content ?? []) || finalText;
      sessionLog?.write({
        t: "llm_turn", range: input.range, turn: turnCount++,
        role: msg.role ?? "assistant",
        content: msgText.slice(0, 60000),
        usage: u ? { input: turnInput, cached: (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0), output: turnOutput, raw: u } : undefined,
        stopReason: msg.stopReason ?? undefined,
      });
      if (u) {
        inputTokens += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        cachedTokens += (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        outputTokens += (u.output ?? 0) + (u.reasoning ?? 0);
      } else if (!finalText && msg.stopReason === "stop") {
        const textBlocks = (msg.content ?? []).filter((c: any) => c.type === "text");
        if (textBlocks.length) finalText = textBlocks.map((t: any) => t.text).join("");
      }
    }
  });

  sessionLog?.write({
    t: "extract_start", range: input.range,
    startChapter: input.startChapter, endChapter: input.endChapter,
    chapterCount: input.texts.length,
    chars: input.texts.reduce((s, x) => s + x.text.length, 0),
  });
  sessionLog?.write({ t: "prompt", range: input.range, system: systemPrompt, user: userMessage });

  const tExtract = Date.now();
  try {
    await agent.prompt(userMessage);

    // 顶层结构形状守卫：提取结果必须是"抽取 JSON 根对象"（isExtractionRootObject，与校验器共用）。
    // 防止 extractJson 退路算法把"嵌套对象片段"（单个实体/能力条目、search_existing_entities 工具回显等）
    // 当整批输出——那会静默抽空整批仍标记 done（数据丢失级 bug）。
    const json = extractJson(finalText, (o) => isExtractionRootObject(o));
    if (json === null) {
      // 区分"截断"与"格式错误"：让 pipeline 的反馈机制能给出针对性修复提示（见 prompts.buildFixInstruction）
      if (lastStopReason === "length") {
        throw new Error("Agent 输出被截断（达到输出上限，JSON 不完整）");
      }
      throw new Error("Agent 输出无法解析为 JSON（可能 JSON 语法错误、或只提取到了嵌套对象片段）");
    }
    if (toolCalls > 0) {
      log(`  [${input.range}] agent 工具调用 ${toolCalls} 次（search_existing_entities）`);
    }
    sessionLog?.write({
      t: "extract_end", range: input.range, status: "ok",
      turns: turnCount, toolCalls,
      durationMs: Date.now() - tExtract,
      usage: { inputTokens, cachedTokens, outputTokens },
    });
    return {
      output: json,
      usage: {
        inputTokens: inputTokens || 0,
        cachedTokens: cachedTokens || 0,
        outputTokens: outputTokens || 0,
      },
    };
  } catch (e) {
    sessionLog?.write({
      t: "extract_end", range: input.range, status: "error",
      turns: turnCount, toolCalls,
      durationMs: Date.now() - tExtract,
      usage: { inputTokens, cachedTokens, outputTokens },
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}