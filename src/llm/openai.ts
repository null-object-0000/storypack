// OpenAI-compatible LLM Provider，基于 @earendil-works/pi-ai 实现。
// 支持 30+ 提供商：DeepSeek / Qwen / OpenAI / Anthropic / Google / 以及任何 OpenAI-compatible 端点。
// 配置：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 环境变量。
// 流式输出默认开启，兼容 reasoning_content 推理模型。

import { createModels, createProvider } from "@earendil-works/pi-ai";
import { stream as piStream, streamSimple as piStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ChatMessage, CompletionOptions, CompletionResult, LlmProvider } from "./types.js";
import { estimateTokens } from "../util.js";

export interface PiAiOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number; // 整个请求（含流式）的超时，毫秒
  contextWindow?: number; // 模型上下文窗口（tokens），默认 128000，可用 LLM_CONTEXT_WINDOW 覆盖
  maxTokens?: number;     // 模型单次最大输出（tokens），默认 8192，可用 LLM_MAX_TOKENS 覆盖
  /** 推理协议（config.llm.thinkingFormat；环境变量 LLM_THINKING_FORMAT 优先） */
  thinkingFormat?: "auto" | "deepseek" | "zai" | "qwen" | "openrouter" | "openai";
  /** 抽取时的思考强度（config.llm.extractReasoning；环境变量 LLM_EXTRACT_REASONING 优先） */
  extractReasoning?: "off" | "low" | "medium" | "high";
}

interface PiModels {
  models: ReturnType<typeof createModels>;
  model: any;
}

/** 推理模型协议判定：模型名含 deepseek/Qwen/glm 等 → 强制对应 thinkingFormat，使 reasoning:"off" 真正生效。
 *  优先级：config.llm.thinkingFormat（经 PiAiProvider.thinkingFormat）> 环境变量 LLM_THINKING_FORMAT > 自动检测。
 *  glm 系（z.ai / 智谱 GLM）：thinkingFormat=zai —— pi-ai 在 zai 格式下默认发送 thinking:{type:"disabled"}，
 *  模型回答才落在 content（否则 glm 会把整段回答塞进 reasoning_content、content 为空，导致 Agent 拿不到文本）。 */
function deepseekCompat(modelName: string, thinkingFormat: string): Record<string, unknown> {
  const name = modelName.toLowerCase();
  const fmt = thinkingFormat.toLowerCase();
  const isDeepseek = fmt === "deepseek" || (fmt === "auto" && (name.includes("deepseek") || name.includes("ds-")));
  const isZai = fmt === "zai" || (fmt === "auto" && name.includes("glm"));
  const isQwen = fmt === "qwen" || (fmt === "auto" && name.includes("qwen"));
  if (fmt === "openai") return {};
  if (isDeepseek) {
    // deepseek 协议：max_tokens 字段 + reasoning_content 带回传 + thinking 参数
    return {
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens" as const,
      requiresReasoningContentOnAssistantMessages: true,
      supportsReasoningEffort: true,
    };
  }
  if (isZai) return { thinkingFormat: "zai" };
  if (isQwen) return { thinkingFormat: "qwen" };
  return {};
}

/** 内置模型规格（对齐 deepseek-harness llm-deepseek 适配 + pi-ai 官方注册表）：
 *  模型名 → 上下文/最大输出。未收录的模型回落 config / 环境变量 / 默认（128k / 8192）。
 *  v4 系列：contextWindow=1M（1_000_000 tokens）、maxTokens 保守默认 256K（harness DEFAULT_MAX_TOKENS=256e3；
 *  pi-ai 注册表标 384K 为上限，这里取 harness 的保守默认，避免撑爆服务端）。 */
const MODEL_SPECS: Record<string, { contextWindow?: number; maxTokens?: number }> = {
  "deepseek-v4-flash": { contextWindow: 1000000, maxTokens: 256000 },
  "deepseek-v4-pro": { contextWindow: 1000000, maxTokens: 256000 },
  // flowlet 本地端点实际服务的是 deepseek-v4 系列（/v1/models 返回 id=flowlet-flash/pro、
  // 响应体 model=deepseek-v4-flash），故对齐 1M 上下文 / 256K 输出，避免回落 128k/8192 导致构建输出被截断。
  "flowlet-flash": { contextWindow: 1000000, maxTokens: 256000 },
  "flowlet-pro": { contextWindow: 1000000, maxTokens: 256000 },
};

export class PiAiProvider implements LlmProvider {
  readonly name = "openai";
  readonly modelName: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  private readonly opts: PiAiOptions;
  private pi: PiModels | null = null;

  constructor(opts: PiAiOptions) {
    this.opts = opts;
    this.modelName = opts.model;
    // 优先级：环境变量 > config（llm.contextWindow/maxTokens）> 按模型名内置规格（对齐 pi-ai 注册表）> 默认
    const spec = MODEL_SPECS[opts.model] ?? {};
    this.contextWindow = envInt("LLM_CONTEXT_WINDOW", opts.contextWindow ?? spec.contextWindow ?? 128000);
    this.maxTokens = envInt("LLM_MAX_TOKENS", opts.maxTokens ?? spec.maxTokens ?? 8192);
  }

  /** 推理协议配置：环境变量 LLM_THINKING_FORMAT 优先，其次 config.llm.thinkingFormat，默认 auto */
  private get thinkingFormat(): string {
    return process.env.LLM_THINKING_FORMAT?.trim() || this.opts.thinkingFormat || "auto";
  }

  /** 抽取思考强度：环境变量 LLM_EXTRACT_REASONING 优先，其次 config.llm.extractReasoning，默认 off */
  private get extractReasoning(): "off" | "low" | "medium" | "high" {
    const v = process.env.LLM_EXTRACT_REASONING?.trim() || this.opts.extractReasoning || "off";
    return (["off", "low", "medium", "high"] as const).includes(v as any) ? (v as any) : "off";
  }

  private ensure(): PiModels {
    if (!this.pi) {
      const provider = createProvider({
        id: "llm",
        name: "Custom OpenAI-compatible",
        baseUrl: this.opts.baseUrl,
        auth: {
          apiKey: {
            name: "LLM API key",
            login: async () => {
              throw new Error("请设置 LLM_API_KEY 环境变量");
            },
            resolve: async () => {
              if (!this.opts.apiKey) return undefined;
              return { auth: { apiKey: this.opts.apiKey }, source: "LLM_API_KEY" };
            },
          },
        },
        models: [
          {
            id: this.modelName,
            name: this.modelName,
            api: "openai-completions" as const,
            provider: "llm" as const,
            baseUrl: this.opts.baseUrl,
            reasoning: true,
            input: ["text"] as const,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: this.contextWindow,
            maxTokens: this.maxTokens,
            // 自定义端点 + 推理模型的兼容设置：
            // 自定义 baseUrl 不会被 pi-ai 自动识别为 deepseek，导致 thinkingFormat 走默认分支、
            // reasoning:"off" 无法真正发送 thinking:{type:"disabled"}（此前输出预算被思考吃光的根因）。
            // 优先级：config.llm.thinkingFormat > 环境变量 LLM_THINKING_FORMAT > 模型名自动识别。
            compat: {
              supportsDeveloperRole: false,
              ...deepseekCompat(this.modelName, this.thinkingFormat),
            },
          },
        ],
        api: { stream: piStream, streamSimple: piStreamSimple },
      });
      const models = createModels();
      models.setProvider(provider);
      const model = models.getModels()[0];
      if (!model) throw new Error("pi-ai 模型创建失败");
      this.pi = { models, model };
    }
    return this.pi;
  }

  async complete(messages: ChatMessage[], extra?: CompletionOptions): Promise<CompletionResult> {
    const { models, model } = this.ensure();
    const systemPrompt = messages.find((m) => m.role === "system")?.content ?? "";
    const userMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content }));

    const opts: Record<string, unknown> = {
      temperature: extra?.temperature ?? 0.2,
    };
    if (extra?.reasoning) {
      opts.reasoning = extra.reasoning;
    }
    if (extra?.jsonMode) {
      opts.samplingParams = { response_format: { type: "json_object" } };
    }

    const stream = extra?.stream ?? true;
    const onToken = extra?.onToken;

    const context: any = { systemPrompt, messages: userMessages };

    const run = (): Promise<CompletionResult> => {
      if (stream) {
        return this.streamComplete(models, model, context, opts, onToken);
      }
      return models.completeSimple(model, context, opts).then((result: any) => {
        if (result.stopReason === "error") {
          throw new Error(result.errorMessage ?? "LLM 返回错误");
        }
        const text = contentBlocks(result.content);
        const usage = result.usage ?? {};
        const cached = (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        return {
          content: text,
          inputTokens: usage.input ?? estimateTokens(JSON.stringify(messages)),
          cachedTokens: cached,
          outputTokens: (usage.output ?? 0) + (usage.reasoning ?? 0) || estimateTokens(text),
          model: result.model || this.modelName,
        };
      });
    };

    const timeout = this.opts.timeoutMs ?? 300_000;
    return withTimeout(run(), timeout, `LLM 请求超时（${timeout}ms）`);
  }

  private async streamComplete(
    models: ReturnType<typeof createModels>,
    model: any,
    context: any,
    opts: Record<string, unknown>,
    onToken?: (text: string) => void
  ): Promise<CompletionResult> {
    const stream = models.streamSimple(model, context, opts);
    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let modelName = this.modelName;

    for await (const raw of stream) {
      const ev: any = raw;
      switch (ev.type) {
        case "text_delta": {
          const delta: string = ev.delta;
          if (delta) {
            content += delta;
            onToken?.(delta);
          }
          break;
        }
        case "usage": {
          inputTokens = ev.input ?? 0;
          outputTokens = (ev.output ?? 0) + (ev.reasoning ?? 0);
          cachedTokens = (ev.cacheRead ?? 0) + (ev.cacheWrite ?? 0);
          if (ev.model) modelName = ev.model;
          break;
        }
        case "error": {
          throw new Error(ev.error?.errorMessage ?? ev.error?.error ?? "LLM 流式请求失败");
        }
        case "done": {
          if (ev.message?.usage) {
            const u = ev.message.usage;
            inputTokens = u.input ?? 0;
            outputTokens = (u.output ?? 0) + (u.reasoning ?? 0);
            cachedTokens = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
          }
          if (ev.message?.model) modelName = ev.message.model;
          break;
        }
      }
    }

    if (!content) {
      throw new Error("LLM 流式响应未返回有效文本");
    }
    return {
      content,
      inputTokens: inputTokens || estimateTokens(content),
      cachedTokens,
      outputTokens: outputTokens || estimateTokens(content),
      model: modelName,
    };
  }

  /** 模型能力（用于 Build 自适应批次大小） */
  getCapabilities(): { contextWindow: number; maxTokens: number } {
    return { contextWindow: this.contextWindow, maxTokens: this.maxTokens };
  }

  /** Agent 能力：暴露 pi-ai 的 model 与 stream 函数，供 pi-agent-core 的 Agent 循环使用 */
  getAgentKit(): { model: unknown; streamFn: unknown } {
    const { models, model } = this.ensure();
    // 抽取时按 config.llm.extractReasoning 控制思考强度（默认 off）：
    // 必须把 reasoning 显式写进 stream opts。Agent 默认 thinkingLevel="off" 时只传 reasoning: undefined，
    // 对 DeepSeek 系推理模型（flowlet 等）等于没关思考——推理前言会泄漏进 JSON 输出
    // （既让 extractJson 解析失败，又把输出预算吃光导致截断）。显式 "off" 才会发 thinking:{type:"disabled"}。
    const reasoning = this.extractReasoning; // "off" | "low" | "medium" | "high"
    return {
      model,
      streamFn: (m: unknown, context: unknown, opts?: Record<string, unknown>) =>
        (models.streamSimple as (model: unknown, context: unknown, opts?: Record<string, unknown>) => AsyncIterable<unknown>)(
          m,
          context,
          { ...(opts ?? {}), reasoning }
        ),
    };
  }
}

/** 从环境变量读取正整数，非法/缺失时回退默认值 */
function envInt(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 带超时包装：完成后立即清除计时器，避免进程悬挂 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** 从 pi-ai 的 content 块（thinking + text）中提取纯文本 */
function contentBlocks(blocks: { type: string; text?: string }[]): string {
  return (blocks ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

/** 修复常见 JSON 语法瑕疵（只动"结构标点"，绝不改字符串内容）：
 *  字符串外的 全角逗号/冒号/分号（，：；）→ 半角（, : ;）——
 *  模型把中文标点当作 JSON 结构分隔符是最高频的语法错误（如 `"value": "xxx"， "chapter": 4`）。
 *  字符串内部保持原样。 */
function repairFullWidthStructuralPunct(text: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "，" || ch === "：" || ch === "；") {
      out += ch === "，" ? "," : ch === "：" ? ":" : ";";
      continue;
    }
    out += ch;
  }
  return out;
}

/** 候选 JSON 对象的接受谓词：用于构建侧过滤掉"嵌套对象片段"（如单个 newEntities 条目）。 */
export type JsonAccept = (obj: Record<string, unknown>) => boolean;

/** 从模型输出中提取 JSON（容忍 markdown 代码块、前后杂质、全角结构标点）。
 *  流程：原文本 parse → 全角结构标点修复后 parse → 逐个 "{" 配对尝试（取【最大跨度】且通过 accept 的候选）。
 *  accept 提供时：候选对象必须被接受才返回——构建侧用它排除"只提取到嵌套对象片段"的假成功
 *  （模型 JSON 语法错误时，旧的退路算法会落到第一个可解析的嵌套对象（如单个实体条目），
 *   导致整批静默抽空仍标记 done——这是数据丢失级 bug，必须拦住）。 */
export function extractJson(text: string, accept?: JsonAccept): unknown | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const seen = new Set<string>();
  for (const cand of [t, repairFullWidthStructuralPunct(t)]) {
    if (seen.has(cand)) continue;
    seen.add(cand);
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(cand);
    const c = fence ? fence[1] : cand;
    try {
      const obj = JSON.parse(c);
      if (!accept || accept(obj as Record<string, unknown>)) return obj;
    } catch {
      // 继续退路
    }
    // 退路：收集所有 "{" 位置，从前往后找能解析出【完整】JSON 对象的候选——
    // 推理前言/解释文字里混入的花括号占位（如 "{...}"）通常解析失败会被跳过。
    const starts: number[] = [];
    for (let i = 0; i < c.length; i++) {
      if (c[i] === "{") starts.push(i);
    }
    let best: unknown = null;
    let bestSpan = -1;
    for (let k = 0; k < starts.length; k++) {
      const end = matchJsonObjectEnd(c, starts[k]);
      if (end === -1) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(c.slice(starts[k], end + 1));
      } catch {
        continue; // 该候选不可解析，继续试下一个 "{"（可能是前言里的伪 JSON/缩写占位）
      }
      if (accept && !accept(obj as Record<string, unknown>)) continue;
      // 最大跨度优先：外层完整对象（能解析时）总能胜过内部嵌套片段
      if (end - starts[k] > bestSpan) {
        best = obj;
        bestSpan = end - starts[k];
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/** 从 open 位置向后找配对的 "}"（跳过字符串字面量与嵌套对象/数组）；找不到返回 -1 */
function matchJsonObjectEnd(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}