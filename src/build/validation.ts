// 抽取输出的 runtime schema 校验。校验失败 → 重试；重试仍失败 → 整批跳过并记日志（绝不脏数据入库）。
//
// V0.1 收口：校验范围从“1..maxChapter”改为【当前 Batch 范围】startChapter..endChapter。
// Extraction Agent 只阅读 startChapter~endChapter 的章节，因此本批新抽取数据只允许产生
// 该范围内的 Facts/Relations/Abilities/Events/MemoryAnchors/Aliases/首次登场。
// 即使某章节号确实存在于整本书中（比如第 800 章存在），只要它不属于本批范围，就属于幻觉/数据错误。
//
// 例外：能力的 acquiredChapter（获得章节）是“故事内获得时间”的元信息，允许引用本批之前的过去
// （如本章揭露“此能力是 100 章获得的”），但不能指向本批之后（<= endChapter）。

import { ENTITY_TYPES } from "../db/repo.js";

export const FACT_TYPES = new Set([
  "role", "identity", "personality", "affiliation", "status", "occupation",
  "appearance", "ability", "habit", "description", "other",
]);

/** MemoryAnchor 记忆线索类型（轻量，不做复杂 ontology）：
 *  visual=外貌/视觉画面 | behavior=典型行为/动作 | habit=习惯/重复特征 |
 *  interaction=与主角或重要角色的典型互动 | role=日常职责/团队定位 | quote=说话方式/口头特征 */
export const MEMORY_ANCHOR_KINDS = new Set(["visual", "behavior", "habit", "interaction", "role", "quote"]);

export interface ExtractionBundle {
  newEntities: { name: string; type: string; firstSeenChapter: number; evidence: string | null }[];
  aliases: { entityName: string; alias: string; fromChapter: number; evidence: string | null }[];
  facts: { entityName: string; type: string; value: string; chapter: number; confidence: number; evidence: string | null }[];
  relations: {
    fromName: string; toName: string; type: string; detail: string | null;
    chapter: number; confidence: number; evidence: string | null;
  }[];
  abilities: {
    entityName: string; name: string; category: string | null; system: string | null; path: string | null;
    level: string | null; sourceEntity: string | null; acquiredChapter: number | null; summary: string | null;
    chapter: number; evidence: string | null;
  }[];
  events: { chapter: number; participantNames: string[]; type: string; summary: string; importance: number; evidence: string | null }[];
  memoryAnchors: {
    entityName: string; chapter: number; summary: string; kind: string | null;
    importance: number; memorability: number; protagonistRelevance: number; evidence: string | null;
  }[];
  possibleDuplicates: { entityA: string; entityB: string; reason: string }[];
  conflicts: { kind: string; entityName: string | null; detail: string; chapterA: number | null; chapterB: number | null }[];
  batchSummary: string | null;
  /** 非致命提示（如"evidence 在更早章节也出现，可能不是最早 Reveal Chapter"），pipeline 只记日志不失败 */
  warnings: string[];
}

export class ValidationError extends Error {}

/**
 * 校验失败反馈的"点名升级"：对 newEntities.type 非法这类错误，
 * 直接从原始输出里找出所有非法实体条目并点名，让反馈比泛化提示更可执行
 * （模型已多次无视泛化提示"请移出 newEntities"，点名具体条目更能打破死循环）。
 * 若无法定位到具体条目，则退回原始错误信息。
 */
export function buildValidationFeedback(raw: unknown, error: string): string {
  if (!error.includes("newEntities.type 非法")) return error;
  const names: string[] = [];
  if (typeof raw === "object" && raw !== null) {
    const arr = (raw as Record<string, unknown>).newEntities;
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (typeof e === "object" && e !== null && !ENTITY_TYPES.includes((e as { type?: unknown }).type as any)) {
          names.push(String((e as { name?: unknown }).name ?? "?"));
        }
      }
    }
  }
  if (names.length === 0) return error;
  return `${error}。请从 newEntities 中【删除】以下条目（它们不是合法实体类型；若为能力，能力本体已在 abilities 数组记录，不得再作为实体）：${names.join("、")}`;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function checkChapterInRange(v: unknown, startChapter: number, endChapter: number, label: string): number {
  const n = num(v);
  if (n === null || !Number.isInteger(n) || n < startChapter || n > endChapter) {
    throw new ValidationError(`${label} 章节号非法：${JSON.stringify(v)}（本批范围 ${startChapter}..${endChapter}）`);
  }
  return n;
}

function checkPastChapter(v: unknown, endChapter: number, label: string): number {
  const n = num(v);
  if (n === null || !Number.isInteger(n) || n < 1 || n > endChapter) {
    throw new ValidationError(`${label} 章节号非法：${JSON.stringify(v)}（必须 >= 1 且 <= 本批末章 ${endChapter}）`);
  }
  return n;
}

function checkConfidence(v: unknown, label: string): number {
  const n = num(v);
  if (n === null || n < 0 || n > 1) {
    throw new ValidationError(`${label} confidence 非法：${JSON.stringify(v)}`);
  }
  return n;
}

// ---------- Evidence / Provenance Grounding ----------

/** 证据文本归一化：NFKC（全角→半角）+ 移除所有标点/符号 + 移除所有空白（含换行）+ 小写。
 *  用于"evidence 是否存在于该章原文"的确定性验证（只做 normalize + substring，不做语义/模糊匹配）。 */
export function normalizeEvidenceText(s: string): string {
  return (s || "")
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** evidence 是否"存在于"某章原文（三类确定性匹配，见 evidenceInChapter）。
 *  原文缺失 / evidence 为空 → false。 */

/** evidence 超过此长度时不参与容错匹配（只做严格 substring，防长引文乱配） */
const TOLERANT_MAX_LEN = 40;
/** 近字匹配预算：允许的增/删/改字数 = max(1, floor(len/10))（≤25 字 → 1~2 字差异）
 *  覆盖"多写/漏写/改写一个字"的常见引用偏差（如「身上的零件」被写成「身体上的零件」）。 */
function editBudget(len: number): number {
  return Math.max(1, Math.floor(len / 10));
}
/** 省略匹配：chapter 侧每段可省略的填充字上限 / 全程总省略上限
 *  覆盖"同一句内略掉填充成分"（如「几根头发，与微小的碎皮屑全部收集起来」→「几根头发收集起来」），
 *  跨句/远距离"静默拼接"（gap 超限）仍然拒绝。 */
const GAP_RUN_MAX = 12;
const GAP_TOTAL_MAX = 16;
/** 省略匹配：evidence 侧允许的改写/多写字数上限（如原文「身上」evidence 写「身体上」的互补场景） */
const EVIDENCE_SKIP_MAX = 2;

/** 子串编辑距离：needle 与 haystack 中"某个连续片段"的最小增删改距离。
 *  行首/行尾对 haystack 免费跳过（= "子串"语义），片段内部的多余字按 1 字 1 距离计。 */
function substringEditDistance(needle: string, haystack: string): number {
  const m = needle.length;
  const n = haystack.length;
  if (m === 0) return 0;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = 0; // 免费跳过 haystack 前导
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = needle[i - 1] === haystack[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return Math.min(...prev); // 免费跳过 haystack 尾段
}

/** 近字容错：evidence 与原文某连续片段仅差 1~2 字（对 ≤25 字 evidence 而言）。 */
function nearMatch(ne: string, nt: string): boolean {
  if (ne.length < 4 || ne.length > TOLERANT_MAX_LEN) return false;
  return substringEditDistance(ne, nt) <= editBudget(ne.length);
}

/** 省略容错：evidence 可对齐为原文某连续片段的子序列——chapter 侧的省略每段 ≤ GAP_RUN_MAX、
 *  总计 ≤ GAP_TOTAL_MAX；evidence 侧的改写/多写字 ≤ EVIDENCE_SKIP_MAX；必须匹配 ≥ len-2 个字。
 *  对齐以 evidence 首字在原文中的【每个出现位置】为候选起点（贪心锚定第一个出现位置会锚错场景，
 *  例如「将」先出现在“将这枚琉璃丢进去”，真正要引的是更后面的“将散落在枕头上的…”）。
 *  返回 true 表示"读者仍能认出这是该章原话的引用"。 */
function gapSequenceMatch(ne: string, nt: string): boolean {
  if (ne.length < 2) return false;
  const minMatched = Math.max(4, ne.length - EVIDENCE_SKIP_MAX);
  const first = ne[0];
  for (let start = 0; start < nt.length; start++) {
    if (nt[start] !== first) continue;
    if (gapAlignFrom(ne, nt, start, minMatched)) return true;
  }
  return false;
}

/** 从给定起点把 ne 前向对齐进 nt（gap 约束下）。起点处 nt[start] === ne[0]。 */
function gapAlignFrom(ne: string, nt: string, start: number, minMatched: number): boolean {
  let i = 0, j = start;
  let matched = 0, totalGap = 0, eSkip = 0;
  while (i < ne.length && j < nt.length) {
    if (ne[i] === nt[j]) {
      matched++;
      i++;
      j++;
      continue;
    }
    // evidence 侧改写/多写：当前 evidence 字符在 chapter 里没有，但下一个字符能接上 → 跳过 1 字
    if (i + 1 < ne.length && ne[i + 1] === nt[j] && eSkip < EVIDENCE_SKIP_MAX) {
      eSkip++;
      i++;
      continue;
    }
    // chapter 侧省略：跳过若干填充字（gap 有上限，防跨句拼接）
    const gapStart = j;
    while (j < nt.length && ne[i] !== nt[j]) j++;
    if (j >= nt.length) break;
    const gap = j - gapStart;
    if (gap > GAP_RUN_MAX) return false;
    totalGap += gap;
    if (totalGap > GAP_TOTAL_MAX) return false;
    matched++;
    i++;
    j++;
  }
  if (i < ne.length) eSkip += ne.length - i; // 末尾未对齐的 evidence 字视为改写
  if (eSkip > EVIDENCE_SKIP_MAX) return false;
  return matched >= Math.max(minMatched, ne.length - eSkip);
}

/** evidence 是否存在于某章原文（确定性验证，三类匹配：
 *  1) normalize 后【连续出现】（严格，最高优先级）；
 *  2) 与原文某连续片段仅 1~2 字差异（近字容错：多/少/改一个字）；
 *  3) 可对齐为某连续片段的子序列、仅省略少量填充字（同句省略；跨句/远距离拼接拒绝）。
 *  类 2/3 只对 ≤40 字的短 evidence 生效——长引文仍按严格 substring 判定，防止"语义相近就放行"。
 *  原文缺失 → false。 */
export function evidenceInChapter(evidence: string, chapterText: string | undefined): boolean {
  const e = normalizeEvidenceText(evidence);
  if (!e) return false;
  if (!chapterText) return false;
  const nt = normalizeEvidenceText(chapterText);
  if (!nt) return false;
  if (nt.includes(e)) return true;
  return nearMatch(e, nt) || gapSequenceMatch(e, nt);
}

/** 单个原文 char 在 normalize 后贡献的字符数（标点/空白 → 0；NFKC 合并字符按其展开长度计） */
function normalizedLen(ch: string): number {
  return normalizeEvidenceText(ch).length;
}

/** 把 normalized 偏移区间映射回原文偏移区间（逐字对齐，标点/空白不占 normalized 位） */
function rawSpanForNorm(raw: string, startN: number, lenN: number): { start: number; end: number } {
  let n = 0;
  let start = -1;
  let end = -1;
  for (let r = 0; r < raw.length; r++) {
    const cn = normalizedLen(raw[r]);
    if (cn === 0) continue;
    if (start === -1 && n >= startN) start = r;
    if (n < startN + lenN && n + cn > startN + lenN) { end = r + 1; break; }
    if (n >= startN && n < startN + lenN) end = r + 1;
    n += cn;
  }
  if (start === -1) start = 0;
  if (end === -1) end = Math.min(raw.length, start + lenN + 8);
  return { start, end };
}

/** 取 evidence 在原文中的上下文片段（诊断显示用，非入库数据） */
function snippetAround(raw: string, nt: string, ne: string): string {
  if (!raw || !nt) return "";
  let startN = nt.indexOf(ne);
  if (startN === -1) {
    // 容错命中：用最长连续前缀近似定位
    let prefix = 0;
    for (let i = 1; i <= ne.length; i++) {
      if (nt.includes(ne.slice(0, i))) prefix = i;
      else break;
    }
    if (prefix === 0) return raw.slice(0, 60).replace(/\s+/g, " ");
    startN = nt.indexOf(ne.slice(0, prefix));
  }
  if (startN === -1) return raw.slice(0, 60).replace(/\s+/g, " ");
  const { start, end } = rawSpanForNorm(raw, startN, ne.length);
  return raw
    .slice(Math.max(0, start - 16), Math.min(raw.length, end + 24))
    .replace(/\s+/g, " ");
}

// ---------- 关键短语接地（Evidence Phrase Grounding） ----------

/** 章节原文 → 句子列表（保留逐字原文，供接地结果回贴）。
 *  切分规则：只在 。！？ 后断句（……与换行不断句——小说对白大量按行排版，
 *  按行切会把一句对白切成碎片），跟随其后的收尾引号（”』」）归入前句。 */
export function splitIntoSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "。" && ch !== "！" && ch !== "？") continue;
    let end = i + 1;
    while (end < text.length && (text[end] === "”" || text[end] === "』" || text[end] === "」")) end++;
    if (text.slice(start, end).trim().length > 0) out.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length && text.slice(start).trim().length > 0) out.push(text.slice(start));
  return out;
}

/** 关键短语接地结果 */
export interface GroundedEvidence {
  ok: boolean;
  /** 接地成功的逐字原句（ok=true 时有效） */
  sentence?: string;
  /** 命中强度：3=短语逐字连续出现在句中 2=近字容错 1=少量省略容错 */
  score?: number;
  /** 歧义：短语在本章【多句】都逐字出现（无法确定承载句）→ 判过泛，需换更独特短语 */
  ambiguous?: boolean;
}

/** 在章节原文中为关键短语定位"承载它的那一句"，返回该句逐字原文。
 *  匹配在【单句内】进行（normalize 后）：连续子串 > 近字容错 > 少量省略容错；
 *  跨句短语一律不接地——证据落定的是完整一句话，拼接/编造无法借道通过。
 *  多句命中取强度最高的一句（同强度取最早）；短语在本章多句都出现 → ambiguous=true（过泛）。 */
export function groundEvidencePhrase(phrase: string, chapterText: string): GroundedEvidence {
  const np = normalizeEvidenceText(phrase);
  if (!np || np.length < 2) return { ok: false };
  let best: GroundedEvidence | null = null;
  let exactHits = 0;
  for (const sentence of splitIntoSentences(chapterText)) {
    const ns = normalizeEvidenceText(sentence);
    if (!ns) continue;
    let score = 0;
    if (ns.includes(np)) {
      score = 3;
      exactHits++;
    } else if (np.length <= TOLERANT_MAX_LEN && substringEditDistance(np, ns) <= editBudget(np.length)) score = 2;
    else if (gapSequenceMatch(np, ns)) score = 1;
    if (score > 0 && (!best || score > (best.score ?? 0))) {
      best = { ok: true, sentence: sentence.trim(), score };
    }
    if (best && best.score === 3 && exactHits >= 2) {
      // 歧义已确认（至少两句逐字命中），无需继续
      return { ok: true, sentence: best.sentence, score: 3, ambiguous: true };
    }
  }
  if (!best) return { ok: false };
  return { ...best, ambiguous: (best.score ?? 0) === 3 && exactHits >= 2 };
}

/**
 * 定位关键短语实际出现在本批哪些章节（失败反馈的"定向定位"）。
 * 只做诊断、绝不改数据——模型拿到"该短语实际在第 X 章"后自己决定改 chapter 还是换短语。
 * 两级信号：① 句级接地（强信号，exact = 某句 normalize 后连续包含短语）；
 *          ② 整章容错（弱信号，近似——短语横跨多句或片段分散时仍能提示大致位置）。
 * 返回按章号升序的 { chapter, snippet, exact } 列表。
 */
function locateEvidenceInBatch(
  evidence: string,
  chapterTexts: Map<number, string>,
  skipChapter: number
): { chapter: number; snippet: string; exact: boolean }[] {
  const np = normalizeEvidenceText(evidence);
  if (!np) return [];
  const out: { chapter: number; snippet: string; exact: boolean }[] = [];
  for (const [c, text] of chapterTexts) {
    if (c === skipChapter) continue;
    const raw = text ?? "";
    // ① 句级接地（强信号）：逐句找承载短语的那一句
    let bestSentence: string | null = null;
    let exact = false;
    for (const sentence of splitIntoSentences(raw)) {
      const ns = normalizeEvidenceText(sentence);
      if (!ns) continue;
      if (ns.includes(np)) {
        exact = true;
        bestSentence = sentence.trim();
        break;
      }
      if (!bestSentence && np.length >= 4 && np.length <= TOLERANT_MAX_LEN && substringEditDistance(np, ns) <= editBudget(np.length)) {
        bestSentence = sentence.trim();
      } else if (!bestSentence && gapSequenceMatch(np, ns)) {
        bestSentence = sentence.trim();
      }
    }
    if (bestSentence) {
      out.push({ chapter: c, exact, snippet: bestSentence.slice(0, 60) });
      continue;
    }
    // ② 整章容错（弱信号，近似）
    const nt = normalizeEvidenceText(raw);
    if (nt && (nearMatch(np, nt) || gapSequenceMatch(np, nt))) {
      out.push({ chapter: c, exact: false, snippet: snippetAround(raw, nt, np) });
    }
  }
  return out.sort((a, b) => a.chapter - b.chapter);
}

/**
 * 为 evidence 校验失败做【定向诊断】（只用于增强错误反馈，不影响通过/失败判定）：
 *  - "splice"   ：evidence 拆开后，两段都单独出现在该章原文，但彼此不连续（中间隔着其他文字）——
 *                 典型是模型把同一章相邻/不相邻两句的片段"静默拼接"（不一定写省略号）成一句话。
 *  - "notfound" ：evidence 的文字在该章完全找不到连续或分散的成分——更可能是总结/改写/编造，或 chapter 填错。
 * 启发式：找"能作为整段出现在原文中的最长前缀"，剩余部分若也单独能在原文中找到且两段都不算太短 → splice。
 * 只命中失败路径（校验失败本就少见），evidence ≤25 字，O(n²) 可忽略。
 */
export function diagnoseEvidenceMismatch(evidence: string, chapterText: string | undefined): "splice" | "notfound" {
  const ne = normalizeEvidenceText(evidence);
  const nt = normalizeEvidenceText(chapterText ?? "");
  if (!ne || !nt) return "notfound";
  let prefixLen = 0;
  for (let i = 1; i <= ne.length; i++) {
    if (nt.includes(ne.slice(0, i))) prefixLen = i;
    else break;
  }
  const rest = ne.slice(prefixLen);
  if (prefixLen >= 2 && rest.length >= 2 && nt.includes(rest)) return "splice";
  return "notfound";
}

/** 校验单条 temporal record 的 evidence：
 *  - chapterTexts 提供时（真实 Build）：
 *    · required 类型（facts/relations/memoryAnchors/aliases/abilities）：必须给出 evidence——它现在是【关键短语】
 *      （4~12 字的独特短语，不必逐字）；校验器把它【接地】到声明章节的某一句话（evidenceInChapter 的单句版：
 *      逐字连续 > 近字容错 > 少量省略容错；跨句/过泛/过短/无法接地 → 记入 errors，并附【定向定位】与【直接修正指令】）。
 *      接地成功后 evidence 落定为该句逐字原话（进 bundle/会话日志，不入库任何业务表）。
 *    · optional 类型（events/newEntities 的 firstSeen）：evidence 可缺，仍按旧引文容错校验，不过仅是 warning（不整批失败）。
 *  - evidence 文本若在同一 Batch 的更早章节也出现，追加"可能不是最早 Reveal Chapter"的非致命 warning；
 *  - chapterTexts 缺失时（纯单元测试）：不要求 evidence，也不做强验证。
 *  错误统一由 validateExtractionOutput 在结尾 join 后抛 ValidationError（交给反馈循环回传 LLM 修正，代码不静默改写 knowledge）。 */
function checkEvidence(
  record: {
    kindLabel: string;
    identify: string;
    chapter: number;
    evidence: string | null;
    required: boolean;
  },
  chapterTexts: Map<number, string> | undefined,
  warnings: string[],
  errors: string[],
  /** 直接修正指令：evidence 已在【其他章节】被校验器确认存在 → 汇总成一行一条的"把 chapter 改为 X"，
   *  置于错误列表最前面。模型对明确指令的遵守率远高于让它自己从诊断段落里找答案。 */
  directives: string[]
): string | null {
  const ev = record.evidence;
  if (!chapterTexts) return ev; // 无原文 map：不做 evidence 验证（单元测试/非 Build 调用）
  const text = chapterTexts.get(record.chapter);
  if (ev === null || ev.trim() === "") {
    if (record.required) {
      errors.push(
        `${record.kindLabel}${record.identify} 缺少 evidence。\n` +
          `每条会影响 Reveal Time 的记录（chapter/fromChapter/firstSeenChapter）都必须提供 evidence（4~12 字的独特关键短语，流水线会把它落定为该章原文中的完整原句；不要总结或编造）。`
      );
    }
    return ev;
  }
  if (!record.required) {
    // 可选类型：evidence 仍按旧路径（引文容错校验，不过仅是 warning，不整批失败）
    if (!evidenceInChapter(ev, text)) {
      warnings.push(
        `${record.kindLabel}${record.identify}：evidence「${ev}」在第${record.chapter}章原文中不存在（可选字段，未据此拦截）。如需保留该记录，请改用该章真实原文 evidence。`
      );
    }
    return ev;
  }

  // ---- required 类型：关键短语接地（Evidence Phrase Grounding）----
  const grounded = groundEvidencePhrase(ev, text ?? "");
  if (!grounded.ok) {
    const ne = normalizeEvidenceText(ev);
    if (ne.length < 2) {
      errors.push(
        `${record.kindLabel}${record.identify} 关键短语过短（normalize 后 ${ne.length} 字）：「${ev}」。\n` +
          `evidence 请给出独特、能定位到第${record.chapter}章原文某句话的关键短语（如「马哥，冰泉街那边来消息了」），流水线会自动落定该句原话。`
      );
      return ev;
    }
    // 诊断：整章层面能否找到（能 → 短语横跨多句；不能 → 不存在/编造/章号错）
    const nt = normalizeEvidenceText(text ?? "");
    const across = nt ? nearMatch(ne, nt) || gapSequenceMatch(ne, nt) : false;
    const diagLine = across
      ? `诊断：短语${ne.length <= 8 ? "" : "的片段"}在第${record.chapter}章能零散找到，但【没有任何单独一句】完整承载它——它像是横跨了两句/两处。关键短语必须落在该章【同一句】内（流水线只认单句内的定位）。`
      : `诊断：第${record.chapter}章原文中似乎找不到该关键短语——短语可能是总结/编造，或 chapter 填错。请改用第${record.chapter}章真实原文中某句话内的连续字句（不必逐字，4~12 字即可）。`;
    // 定向定位：短语在本批【其他章节】被句级接地/近似定位到 → 告诉模型它写到了哪一章
    const loc = locateEvidenceInBatch(ev, chapterTexts, record.chapter);
    let locLine = "";
    if (loc.length > 0) {
      const chapters = loc.map((l) => l.chapter).join("、");
      const first = loc[0];
      locLine =
        `\n定位：该短语实际可在第${chapters}章原文中找到` +
        (first.exact ? "" : "（近似）") +
        `——如第${first.chapter}章原文：…${first.snippet}…。` +
        `请把本记录的 chapter 改为短语实际所在的章节；若该知识其实最早在第${record.chapter}章揭晓，则请改用第${record.chapter}章原文中的关键短语。`;
      // 直接修正指令（仅在有"句级精确命中"的定位章节时给出——近似定位只保留诊断，不升级为指令）
      const exacts = loc.filter((l) => l.exact);
      if (exacts.length > 0) {
        const target = exacts[0];
        directives.push(
          `- ${record.kindLabel}「${record.identify}」：关键短语「${ev.slice(0, 25)}」已确认存在于第${target.chapter}章原文（第${target.chapter}章句子：…${target.snippet}…）→ 请把 chapter 从 ${record.chapter} 改为 ${target.chapter}（短语内容保持不变）；若该知识确实最早在第${record.chapter}章揭晓，则请改用第${record.chapter}章原文中的关键短语。`
        );
      }
    }
    errors.push(
      `${record.kindLabel}${record.identify} 声明 chapter=${record.chapter}，但 evidence「${ev}」在第${record.chapter}章原文中不存在（无法接地到该章任何一句，normalize 后未匹配）。\n` +
        `${diagLine}${locLine}\n` +
        `请重新确认该信息首次被读者得知的章节，并提供该章真实原文中的关键短语（4~12 字，来自当前 Batch）。`
    );
    return ev;
  }
  if (grounded.ambiguous) {
    // 歧义守卫：短语在本章多句都出现 → 无法确定承载原句，判"过泛"，要求换更独特短语
    errors.push(
      `${record.kindLabel}${record.identify} 关键短语过泛：「${ev}」在第${record.chapter}章【多句】中都出现，无法确定承载原句。\n` +
        `请换成更独特的关键短语——带上这句话特有的词（如把「马哥」扩成「马哥，冰泉街那边来消息了」），流水线会自动落定该句原话。`
    );
    return ev;
  }

  // 接地成功：evidence 落定为该句逐字原话（进 bundle/会话日志，不入库）
  const effective = grounded.sentence ?? ev;
  // 最早证据 soft warning：同一短语是否在更早章节也出现（提示 chapter 可能不是最早 Reveal）
  const ne = normalizeEvidenceText(ev);
  for (const [c, t] of chapterTexts) {
    if (c < record.chapter && normalizeEvidenceText(t).includes(ne)) {
      warnings.push(
        `${record.kindLabel}${record.identify}：关键短语「${ev}」在第${c}章也出现，声明章节 ${record.chapter} 可能不是最早 Reveal Chapter（如需更精确，请改用第${c}章的 evidence）。`
      );
      break;
    }
  }
  return effective;
}

/** 抽取 JSON 的顶层数组字段（不含 batchSummary 字符串） */
export const EXTRACTION_ARRAY_KEYS = [
  "newEntities", "aliases", "facts", "relations", "abilities",
  "events", "memoryAnchors", "possibleDuplicates", "conflicts",
] as const;

/**
 * 判断对象是否"像"抽取 JSON 根对象（供 extractJson 的 accept 谓词与校验器共用）：
 *  - 含任一"根专属"数组字段（newEntities/relations/abilities/events/memoryAnchors/possibleDuplicates/conflicts）→ 是；
 *  - 或含 ≥3 个数组类型的抽取字段（排除单个实体条目/能力条目/工具回显——它们只有 name/type/aliases/facts(数字)/anchors 等）。
 * 这样嵌套对象片段（模型 JSON 语法错误时 extractJson 退路会先碰到它们）不会被当成整批输出。
 */
export function isExtractionRootObject(o: Record<string, unknown>): boolean {
  const rootOnly = ["newEntities", "relations", "abilities", "events", "memoryAnchors", "possibleDuplicates", "conflicts"];
  if (rootOnly.some((k) => Array.isArray(o[k]))) return true;
  let n = 0;
  for (const k of EXTRACTION_ARRAY_KEYS) if (Array.isArray(o[k])) n++;
  return n >= 3;
}

export function validateExtractionOutput(
  raw: unknown,
  startChapter: number,
  endChapter: number,
  chapterTexts?: Map<number, string>
): ExtractionBundle {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("输出必须是 JSON 对象");
  }
  const o = raw as Record<string, unknown>;
  // 顶层结构形状守卫：抽取 JSON 必须"看起来像抽取根对象"。
  // 防止 JSON 解析退路把"嵌套对象片段"（单个实体条目/能力条目/search_existing_entities 工具回显等）
  // 当整批输出——那会静默抽空整批仍标记 done（数据丢失级 bug）。
  // 消息含"无法解析为 JSON"以触发 buildFixInstruction 的 JSON 修复提示。
  if (!isExtractionRootObject(o)) {
    throw new ValidationError(
      "无法解析为 JSON：输出对象不是抽取 JSON（疑似只提取到了嵌套对象片段，缺少抽取根结构）。请只输出一个【完整】的抽取 JSON 对象。"
    );
  }
  const arr = (k: string): unknown[] => (Array.isArray(o[k]) ? (o[k] as unknown[]) : []);
  const warnings: string[] = [];
  /** 收集全部 evidence 错误（而不是遇到第一个就抛）——一次性报给 LLM，让它一轮修完，
   *  避免"一次只修一条、下一轮暴露下一条"的打地鼠死循环（21 章大批次有 5~10 条 evidence 错误时尤其致命）。 */
  const errors: string[] = [];
  /** 直接修正指令（evidence 已在其他章节被确认 → "把 chapter 改为 X"），置于错误列表最前面 */
  const directives: string[] = [];

  // entity refs in this batch（新实体名）
  const newNames = new Set<string>();
  const newEntities: ExtractionBundle["newEntities"] = [];
  for (const e of arr("newEntities")) {
    if (typeof e !== "object" || e === null) throw new ValidationError("newEntities 元素必须是对象");
    const name = str((e as any).name);
    const type = str((e as any).type);
    if (!name) throw new ValidationError("newEntities.name 缺失");
    if (!type || !ENTITY_TYPES.includes(type as any)) throw new ValidationError(`newEntities.type 非法：${type}`);
    const chapter = checkChapterInRange((e as any).firstSeenChapter, startChapter, endChapter, `实体 ${name}`);
    const evidence = checkEvidence({ kindLabel: "新实体", identify: `「${name}」首次出场`, chapter, evidence: str((e as any).evidence), required: false }, chapterTexts, warnings, errors, directives);
    newNames.add(name);
    newEntities.push({ name, type, firstSeenChapter: chapter, evidence });
  }

  const aliases: ExtractionBundle["aliases"] = [];
  for (const a of arr("aliases")) {
    if (typeof a !== "object" || a === null) throw new ValidationError("aliases 元素必须是对象");
    const entityName = str((a as any).entityName);
    const alias = str((a as any).alias);
    if (!entityName) throw new ValidationError("aliases.entityName 缺失");
    if (!alias) throw new ValidationError("aliases.alias 缺失");
    const chapter = checkChapterInRange((a as any).fromChapter, startChapter, endChapter, `别名 ${alias}`);
    const evidence = checkEvidence({ kindLabel: "别名", identify: `「${alias}」（→${entityName}）`, chapter, evidence: str((a as any).evidence), required: true }, chapterTexts, warnings, errors, directives);
    aliases.push({ entityName, alias, fromChapter: chapter, evidence });
  }

  const facts: ExtractionBundle["facts"] = [];
  for (const f of arr("facts")) {
    if (typeof f !== "object" || f === null) throw new ValidationError("facts 元素必须是对象");
    const entityName = str((f as any).entityName);
    const type = str((f as any).type);
    const value = str((f as any).value);
    if (!entityName) throw new ValidationError("facts.entityName 缺失");
    if (!type) throw new ValidationError("facts.type 缺失");
    if (!value) throw new ValidationError("facts.value 缺失");
    const chapter = checkChapterInRange((f as any).chapter, startChapter, endChapter, `事实 ${value.slice(0, 20)}`);
    const confidence = checkConfidence((f as any).confidence ?? 0.8, `事实 ${value.slice(0, 20)}`);
    const evidence = checkEvidence({ kindLabel: "事实", identify: `实体「${entityName}」「${value.slice(0, 20)}」`, chapter, evidence: str((f as any).evidence), required: true }, chapterTexts, warnings, errors, directives);
    facts.push({ entityName, type, value, chapter, confidence, evidence });
    if (value.length > 500) throw new ValidationError(`事实描述过长：${value.slice(0, 30)}...`);
  }

  const relations: ExtractionBundle["relations"] = [];
  for (const r of arr("relations")) {
    if (typeof r !== "object" || r === null) throw new ValidationError("relations 元素必须是对象");
    const fromName = str((r as any).fromName);
    const toName = str((r as any).toName);
    const type = str((r as any).type);
    if (!fromName || !toName) throw new ValidationError("relations fromName/toName 缺失");
    if (!type) throw new ValidationError("relations.type 缺失");
    if (fromName === toName) throw new ValidationError(`关系两端不能相同：${fromName}`);
    const chapter = checkChapterInRange((r as any).chapter, startChapter, endChapter, `关系 ${fromName}-${toName}`);
    const confidence = checkConfidence((r as any).confidence ?? 0.8, `关系 ${fromName}-${toName}`);
    const evidence = checkEvidence({ kindLabel: "关系", identify: `${fromName}->${toName}「${type}」`, chapter, evidence: str((r as any).evidence), required: true }, chapterTexts, warnings, errors, directives);
    relations.push({ fromName, toName, type, detail: str((r as any).detail), chapter, confidence, evidence });
  }

  const abilities: ExtractionBundle["abilities"] = [];
  for (const ab of arr("abilities")) {
    if (typeof ab !== "object" || ab === null) throw new ValidationError("abilities 元素必须是对象");
    const entityName = str((ab as any).entityName);
    const name = str((ab as any).name);
    if (!entityName) throw new ValidationError("abilities.entityName 缺失");
    if (!name) throw new ValidationError("abilities.name 缺失");
    const chapter = checkChapterInRange((ab as any).chapter, startChapter, endChapter, `能力 ${name}`);
    let acquired: number | null = null;
    const ac = (ab as any).acquiredChapter;
    if (ac !== null && ac !== undefined && ac !== "") acquired = checkPastChapter(ac, endChapter, `能力 ${name} 获得章节`);
    // ability.chapter（Reveal Chapter）需要 evidence；acquiredChapter 是 Story Time（可能描述历史获得），不要求原文在当章直接出现
    const evidence = checkEvidence({ kindLabel: "能力", identify: `实体「${entityName}」能力「${name}」`, chapter, evidence: str((ab as any).evidence), required: true }, chapterTexts, warnings, errors, directives);
    abilities.push({
      entityName, name,
      category: str((ab as any).category),
      system: str((ab as any).system),
      path: str((ab as any).path),
      level: (ab as any).level === null || (ab as any).level === undefined ? null : String((ab as any).level),
      sourceEntity: str((ab as any).sourceEntity),
      acquiredChapter: acquired,
      summary: str((ab as any).summary),
      chapter,
      evidence,
    });
  }

  const events: ExtractionBundle["events"] = [];
  for (const e of arr("events")) {
    if (typeof e !== "object" || e === null) throw new ValidationError("events 元素必须是对象");
    const chapter = checkChapterInRange((e as any).chapter, startChapter, endChapter, `事件`);
    const summary = str((e as any).summary);
    if (!summary) throw new ValidationError("events.summary 缺失");
    const ps = (e as any).participantNames;
    if (ps !== undefined && ps !== null && !Array.isArray(ps)) throw new ValidationError("events.participantNames 必须是数组");
    const names = Array.isArray(ps) ? (ps as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];
    const importn = num((e as any).importance) ?? 0.5;
    const evidence = checkEvidence({ kindLabel: "事件", identify: `「${summary.slice(0, 20)}」`, chapter, evidence: str((e as any).evidence), required: false }, chapterTexts, warnings, errors, directives);
    events.push({ chapter, participantNames: names, type: str((e as any).type) ?? "other", summary, importance: Math.min(1, Math.max(0, importn)), evidence });
  }

  const memoryAnchors: ExtractionBundle["memoryAnchors"] = [];
  for (const m of arr("memoryAnchors")) {
    if (typeof m !== "object" || m === null) throw new ValidationError("memoryAnchors 元素必须是对象");
    const entityName = str((m as any).entityName);
    const summary = str((m as any).summary);
    if (!entityName) throw new ValidationError("memoryAnchors.entityName 缺失");
    if (!summary) throw new ValidationError("memoryAnchors.summary 缺失");
    const chapter = checkChapterInRange((m as any).chapter, startChapter, endChapter, `记忆锚点 ${summary.slice(0, 16)}`);
    // kind：可选；给出时必须是合法类型（轻量枚举，避免自由文本漂移）
    let kind: string | null = null;
    const rawKind = (m as any).kind;
    if (rawKind !== null && rawKind !== undefined && rawKind !== "") {
      kind = str(rawKind);
      if (kind === null || !MEMORY_ANCHOR_KINDS.has(kind)) {
        throw new ValidationError(`记忆锚点 kind 非法：${JSON.stringify(rawKind)}（允许：${[...MEMORY_ANCHOR_KINDS].join("|")}）`);
      }
    }
    const imp = num((m as any).importance) ?? 0.5;
    const mem = num((m as any).memorability) ?? 0.7;
    const pr = num((m as any).protagonistRelevance) ?? 0.5;
    const evidence = checkEvidence({ kindLabel: "记忆锚点", identify: `实体「${entityName}」「${summary.slice(0, 16)}」`, chapter, evidence: str((m as any).evidence), required: true }, chapterTexts, warnings, errors, directives);
    memoryAnchors.push({
      entityName, chapter, summary, kind,
      importance: Math.min(1, Math.max(0, imp)),
      memorability: Math.min(1, Math.max(0, mem)),
      protagonistRelevance: Math.min(1, Math.max(0, pr)),
      evidence,
    });
  }

  const possibleDuplicates: ExtractionBundle["possibleDuplicates"] = [];
  for (const d of arr("possibleDuplicates")) {
    if (typeof d !== "object" || d === null) continue;
    const a = str((d as any).entityA);
    const b = str((d as any).entityB);
    if (a && b && a !== b) {
      possibleDuplicates.push({ entityA: a, entityB: b, reason: str((d as any).reason) ?? "LLM 建议" });
    }
  }

  const conflicts: ExtractionBundle["conflicts"] = [];
  for (const c of arr("conflicts")) {
    if (typeof c !== "object" || c === null) continue;
    const kind = str((c as any).kind) ?? "other";
    const detail = str((c as any).detail);
    if (!detail) continue;
    const a = num((c as any).chapterA);
    const b = num((c as any).chapterB);
    conflicts.push({
      kind,
      entityName: str((c as any).entityName),
      detail,
      chapterA: a !== null && a >= startChapter && a <= endChapter ? a : null,
      chapterB: b !== null && b >= startChapter && b <= endChapter ? b : null,
    });
  }

  const summary = str(o.batchSummary);

  // 一次性抛出全部 evidence 错误（结构错误仍即时抛，见各段 throw）。
  // 【直接修正指令】置于最前：这些记录的 evidence 已被校验器确认存在于所列章节原文，
  // 模型只需照做（改 chapter）即可，无需自行推断——这是对"定位诊断"的强化，不是代改数据。
  if (errors.length > 0) {
    const prefix =
      directives.length > 0
        ? `## 请优先执行以下直接修正（evidence 已由校验器确认存在于所列章节原文；按规则 chapter 必须与 evidence 同章）\n${directives.join("\n")}\n\n`
        : "";
    throw new ValidationError(prefix + errors.join("\n\n"));
  }

  return {
    newEntities, aliases, facts, relations, abilities, events, memoryAnchors,
    possibleDuplicates, conflicts, batchSummary: summary, warnings,
  };
}