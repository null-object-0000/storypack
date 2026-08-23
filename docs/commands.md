# story 关键命令实现文档（init / build / ask）

> 本文档说明关键命令**做了什么、怎么实现的**（代码路径级别）。
> 配套阅读：[README.md](../README.md)（用户视角的使用说明）、`src/db/schema.ts`（数据表）。
>
> **⚠️ 同步约束**：本文档与代码强绑定。任何修改这些命令**行为或实现**的迭代，必须同步更新本文档（详见仓库根 [AGENTS.md](../AGENTS.md)）。

---

## 0. 总览：命令 → 入口 → 核心模块

| 命令 | 命令入口 | 核心实现 | 直接写入/读取的表 |
|---|---|---|---|
| `story init <文件>` | `src/cli/commands/init.ts` → `cmdInit` | `initializeProject`（建 config/schema）+ `cmdImport`（`commands/import.ts`：解析→清空→写章节） | 创建 `.story/config.json`、`story.db`；清空 14 张业务表 → 写 `chapters` |
| `story build` | `src/cli/commands/build.ts` → `cmdBuild` | `build/pipeline.ts` → `runBuild`（分批→抽取→校验→重试→事务入库） | 全部结构化表 + `batch_state` + `llm_logs` |
| `story ask <问题>` | `src/cli/commands/ask.ts` → `cmdAsk` | Agent 路径：`reader/agent.ts` → `askAgent`；传统路径：`reader/answer.ts` → `answerQuestion` | 只读全部结构化表（受 `userChapter` 过滤）+ 写 `llm_logs` |
| `story web [--port N] [--host H]` | `src/cli/commands/web.ts` → `cmdWeb` | `src/web/server.ts` → `startWebServer`（复用 `db/repo.ts` 的 `StoryRepo`、`reader/search.ts` 的 `searchEntities`） | 只读全部结构化表（受 `userChapter` 过滤） |

> 原 `story import` 已合并进 `story init`（初始化必须有小说内容）；TUI 内 `/import` 斜杠命令仍复用 `commands/import.ts` 的 `cmdImport`（会话内更换小说）。

三个贯穿性概念（详见 README §4）：

- `availableThrough` = `MAX(chapters.chapter)`，小说已导入到哪里；
- `builtThrough` = `batch_state` 中 done 批次的最高结束章节，结构化已构建到哪里；
- `userChapter` = 读者读到哪里，是 Ask/TUI/Agent 唯一的防剧透过滤边界（数据访问层实现，不是 prompt 自觉）。

---

## 1. `story init <小说文件>` — 初始化项目并导入整本小说

### 做什么
**初始化必须有小说内容**：一条命令完成「创建项目 + 导入整本小说」。创建 `.story/` 项目（写 `config.json`、建 `story.db` 全表、写书目 meta），同时解析小说文件 → **清空旧数据** → 把识别到的所有章节（含正文）写入 `chapters` 表。整本导入、不物理截断。重新初始化 / 更换小说 = 用新文件再跑一次 `story init`。

### 实现路径
```
cmdInit(<小说文件>, { --book, --user-chapter })
 ├─ initializeProject({ book, userChapter })  # 创建/复用项目配置与 DB
 │     ├─ ensureProjectDir() + initProject()  # 写 .story/config.json（含 build.* 默认值，不存 maxChapter）
 │     └─ new StoryRepo() → setMeta("book")
 ├─ cmdImport({ path, book })                 # commands/import.ts（TUI /import 复用）
 │     ├─ readFileSync(path) → decodeNovel(buf)  # UTF-8 严格 → 回退 GBK → 再回退 latin1
 │     ├─ parseNovel(text)                    # 逐行识别章节标题
 │     ├─ 书名 = --book 或文件名（去扩展名），写回 config
 │     ├─ resetAllData(repo)                  # 单事务 DELETE 14 张业务表（保留 meta）
 │     └─ repo.replaceChapters(chapters)      # 写 chapters 表（number/title/text/chars）
 └─ logInitSummary(cfg, path)                 # 摘要：book / userChapter / novel 路径
```

### 章节解析 `novel/parser.ts`
- 标题正则：阿拉伯数字 `第\s*(\d{1,6})\s*章` 与中文数字 `第四百零五章`（`chineseNumeralToNumber` 支持到 9999）；
- 重复章节号：保留先出现者，`duplicates` 计数并告警；
- 按章节号排序去重；标题行之前的杂项记为 `preambleLines`（不导入）；
- `availableThrough` 由导入结果自动决定，无需配置。

### 关键点
- **初始化必须有小说内容**：不支持建空项目；`story tui` 无配置时在**进入界面前的终端**询问小说文件路径，`q`/回车退出或输入路径后自动完成 init+导入再进入。更换小说 = 用新文件重跑 init（书名跟随新文件，除非 `--book`）。
- **清空全部旧数据**：`resetAllData` 删除 `chapters / entities / aliases / facts / relations / abilities / events / memory_anchors / entity_appearances / possible_duplicates / conflicts / llm_logs / batch_state / review_log`（保留 meta）。重复 init（换书）会丢失上次构建结果。
- **不再存 `maxChapter`**（V0.1 收口）：schema 不把最大章节号编译进 CHECK。
- `userChapter` 默认 1（保守，Ask 只返回第 1 章前的数据）。
- 防剧透边界不在这里：导入的是整本，边界由 Reader 层 `userChapter` 控制。
- TUI `/import` 斜杠命令复用 `cmdImport`（会话内更换小说）。

---

## 3. `story build` — 分批量 LLM 抽取 → 校验 → 事务入库

### 做什么
把 `chapters` 原文按批交给 LLM 抽取结构化知识（实体/别名/事实/关系/能力/事件/记忆锚点），逐批校验、入库，支持断点续跑、失败重试（反馈修复）、成本统计与会话日志。

### 实现路径
```
cmdBuild
 └─ runBuild(repo, provider, opts)            # build/pipeline.ts
     ├─ 1. 计算范围：from/to = clamp(1..dbMax)；dbMax = availableThrough
     ├─ 2. 生成批次：
     │     · 自适应模式 autoBatch（**默认**，config.build.autoBatch=true）：按上下文预算动态合并
     │         inputBudget = (contextWindow − maxTokens) × 0.9 − 固定开销(3000)
     │         单批上限 min(maxBatchChapters, 输出预算折算的章数)
      │         · 输出预算按 config.build.perChapterOutputTokens 折算（默认 320，曾为 260——为 MemoryAnchor 留出预算）；
      │           maxBatchChapters 默认仍 60。真实 60 章大批下 Recall 数据被挤掉的主因是提示词"只抽重要信息/
      │           控制输出长度"的过滤倾向 + "绝不重复已有内容"对稀疏实体的误伤，已由 MemoryAnchor 一等目标 +
      │           Character Recall Sweep + 工具返回 facts/anchors 稀疏度 修正，故本次未缩小默认批量（避免成本失控）
     │         · contextWindow/maxTokens 来源：config.llm.{contextWindow,maxTokens} > 环境变量
     │           LLM_CONTEXT_WINDOW/LLM_MAX_TOKENS > 按模型名内置规格（deepseek-v4-flash/pro = 1M 上下文/256K 输出，
     │           对齐 deepseek-harness llm-deepseek 的 1_000_000/256e3 默认）> provider.getCapabilities() > 默认（128k / 8192）；
     │           maxTokens 同时会作为 API max_tokens 发送
     │     · 固定模式（--batch-size N / config.build.batchSize）：每批 N 章（--batch-size 1 = 逐章，依赖最严格）
     ├─ 3. 断点续跑：跳过 status=done 的批次（batch_state）+ 按"每章都被 done 覆盖"判断
     │         （--force 忽略；failed 批次不会被跳过，下次 build 自动重试）
     ├─ 4. 逐批串行 processBatch：
     │     a. 读取章节文本（按输入预算折算每章字符预算，超长截断）
     │     b. 抽取：Agent 化 agentExtract（build/agent-extractor.ts）——唯一抽取方式
     │         · pi-agent-core Agent + search_existing_entities 工具
     │         · 模型自己决定检索哪些已有实体（返回 canonical name，避免重复建实体）
     │     c. 滚动摘要 rollPreviousSummary：取 start 前最近一个 done 批次的 batchSummary
     │     d. 校验 validateExtractionOutput（build/validation.ts）
     │         · runtime schema（结构/类型/confidence）
     │         · 【Batch Range】所有 chapter 必须在 [start, end] 内（防止幻觉章节号）
     │     e. 失败重试（重试次数 = config.build.retries，默认 2）：
     │         · 校验失败 → 把错误回填为 feedback，注入下次 prompt（见下"修复机制"）
     │         · 网络/超时类错误 → 仅简单重试
     │     f. 校验通过 → 单事务入库（见下"入库"）→ markBatch(status=done, counts, batchSummary)
     │         · addLlmLog（usage/耗时/重试次数）
     │     g. 仍失败 → markBatch(status=failed) + addLlmLog(success=0, error) → 批次记 error 原因
     ├─ 5. 串行执行：批间存在强依赖（search_existing_entities 检索 + 滚动摘要），并发参数已忽略
     └─ 6. failFast（默认 true）：某批失败后停止后续批次（--keep-going 可继续）
```

### Agent 化抽取机制（`build/agent-extractor.ts` → `agentExtract`）
Build 只走 Agent 化抽取（注入式已移除）。与 Ask 的 Reader Agent 不同，**抽取 Agent 读原文**、只产出结构化数据：

- 用 pi-agent-core `Agent` 跑完整循环（含工具调用），系统提示词 = `build/prompts.ts` 的 `EXTRACTION_SYSTEM_PROMPT`（角色定义、抽取原则、实体引用契约、**Reveal Chapter / Evidence Grounding**、Batch Range、输出 JSON 格式、token 精简要求）+ 一段"Agent 工作流程"附录（通读章节 → 批量检索旧实体 → 按 canonical name 引用 → **evidence 定位章节** → 输出唯一 JSON）。
- **只给 2 个工具**（都在 `agent-extractor.ts` 内联定义，Build 专用，Reader 永不使用）：
  - `search_existing_entities`：批量检索知识库已有实体，一次可传 ≤40 个名字，返回命中实体的 `id/name/type/别名` + **`facts`/`anchors` 数量**（≤100 条；数据密度让模型判断稀疏实体是否该补充 MemoryAnchor）。目的：让模型复用已建实体，避免重复建实体；返回的 `name` 是 canonical name，最终 JSON 引用时必须用它（不能用文本里的别名再建实体）。
  - `search_chapter_evidence`：在**当前 Batch 章节原文**中检索某个原文短语，返回它出现在哪些章节及上下文片段（参数 `query`）。用途：输出最终 JSON 前确认某条知识的 `evidence`（原文短引）到底在哪一章，从而正确填写 Reveal Chapter。只搜当前 Batch 原文，Reader 永远不会使用。
- **无工具调用上限**：单批内模型可自由调工具，靠上下文窗口自然收敛；超长循环由 build session-log 观测（`.story/logs/build/`）。
- **抽取思考强度由 `config.llm.extractReasoning` 控制（默认 off）**：`src/llm/openai.ts` 的 `getAgentKit` 把 `extractReasoning` 显式写进 stream opts（Agent 默认只传 `reasoning: undefined`，对 DeepSeek 系推理模型等于没关思考——推理前言会泄漏进 JSON 输出、并吃掉输出预算导致截断）；显式 `"off"` 才真正发 `thinking:{type:"disabled"}`。`extractJson`（`openai.ts`）现在用"逐 `{` 配平找最外层完整 JSON"的兜底提取，推理前言/杂质里混入花括号也不影响定位。
- 模型最终输出必须是一个 JSON 对象（9 个数组：`newEntities / aliases / facts / relations / abilities / events / memoryAnchors / possibleDuplicates / conflicts` + `batchSummary`）。**所有 temporal 记录（aliases/facts/relations/abilities/events/memoryAnchors/newEntities）都要带 `evidence`（该章原文短引）**。输出无法解析为 JSON → 抛错交 pipeline 重试。
- **MemoryAnchor 是一等目标（P0：Character Recall）**：系统提示词（`build/prompts.ts` 的 `EXTRACTION_SYSTEM_PROMPT`）把 MemoryAnchor 重新定义为——"用户未来忘记人物名字后，可能会拿来描述这个人物、并借此重新定位他的具体记忆线索"（不是"重要剧情摘要/高重要度事件"），优先级不低于普通 Fact；并明确区分两个维度：`importance`（剧情重要度）与 `memorability`（记忆识别度）。同一提示词内包含 **Character Recall Sweep**：输出前对当前批次每个重要角色逐个检查（外貌/身体特征、典型行为、重复习惯、日常职责、说话方式、主角初见画面、具体互动、反复出现的物品/动作/场景、"读者忘记名字后最可能用什么模糊描述找他"），有高识别度线索就产出 MemoryAnchor——不因"准确率优先/只抽重要信息/控制输出长度"而过滤外貌、日常行为、习惯、典型动作、说话方式、日常职责等。
- `memoryAnchors` 条目带 `kind`（轻量枚举）：`visual`（外貌/视觉画面）、`behavior`（典型行为/动作）、`habit`（习惯/重复特征）、`interaction`（与主角或重要角色的典型互动）、`role`（日常职责/团队定位）、`quote`（说话方式/口头特征）。旧输出无 `kind` 时校验器兼容为 `null`；给出非法值则整批校验失败。summary 允许略长（≤30 字）以保留"用户可能用来回忆的原话感"（如「高大沉默的三师兄，一路拉着装满戏台道具的板车」）。
- 校验硬规则（`build/validation.ts`）：结构/类型/confidence、**【Batch Range】所有 chapter ∈ [start, end]**（防幻觉章节号）、`newEntities.type ∈ character|organization|location|item|concept`（能力/技能**永远**不能当实体类型）、**【Evidence Grounding】aliases/facts/relations/abilities/memoryAnchors 必须给出 evidence，且 `chapter + evidence` 必须在对应章节原文中确定性验证**（normalize 空白/标点后优先【严格连续出现】；对 ≤40 字短证据额外接受【近字容错】（与原文某连续片段仅差 1~2 字，如「身体上的零件」↔「身上的零件」）与【同句少量省略】（可对齐为某连续片段的子序列，省略每段 ≤12 字、全程 ≤16 字；跨句/远距离拼接仍拒绝）；`events`/`newEntities` 的 evidence 可选但给出也会校验；`ability.acquiredChapter` 是 Story Time，不要求原文在当章直接出现、无需 evidence）。校验失败 → `buildValidationFeedback` 点名 + `buildFixInstruction` 注入下次 prompt（见下"修复机制"）。

### 入库（单事务，全部同步）
```
repo.db.exec("BEGIN")
  newEntities → upsertEntity（same-name-different-type 自动写 possible_duplicates；
                 id 碰撞兜底：模型给名字加装饰标点（如「【浮生绘】」vs「浮生绘」）时归一化 id 相同，
                 并入已有实体并把新名字挂为别名，避免 UNIQUE 冲突整批失败）
  aliases      → addAlias（clash 时 aliasClashToDuplicate 转疑似重复）
  facts        → addFact
  relations    → addRelation
  abilities    → addAbility
  events       → addEvent
  memoryAnchors→ addMemoryAnchor（带 kind：visual|behavior|habit|interaction|role|quote）
  possibleDuplicates → addPossibleDuplicate
  conflicts    → addConflict
  countAppearances → entity_appearances（按实体名/别名统计出场次数）
repo.db.exec("COMMIT")   # 任一步异常 → ROLLBACK，批次记 failed
```

> ⚠️ **evidence 不入库**：模型输出的 `evidence`（原文短引）只用于 Build 期确定性校验，**不写入任何业务表**——Story DB 保持"纯结构化知识"，原文片段永不进入 Reader/Web 数据层（防剧透 + 原文隔离的结构性保证）。

### 修复机制（设计原则：数据修正权在 LLM，代码不静默改写）
- 校验失败 → `buildValidationFeedback(raw, error)` **点名**非法条目（如"请从 newEntities 中删除：杀戮舞曲"）→ 作为 `input.feedback` 传入下一次抽取；
- 下次 prompt 经 `buildFixInstruction(feedback)`（`build/prompts.ts`）注入"校验器原文 + 定向提示"；
- **Evidence 失败也回填 feedback**：如"事实实体「闻人佑」…声明 chapter=384，但 evidence「平日里都是老三做饭」在第384章原文中不存在" → 错误信息带**自动诊断**（`validation.ts` 的 `diagnoseEvidenceMismatch`）：若 evidence 的片段虽都出现在该章、但彼此不连续（模型把该章两处/两句的片段"静默拼接"，即使不写省略号）→ 明确提示改为抄写【单独一句】中连续出现的原文；若该章完全找不到 → 提示 evidence 可能是总结/改写/编造或 chapter 填错；
- **Evidence 失败带【定向定位】（错误章节归因修复，不代改数据）**：最高频失败是"evidence 是真实原句、但 chapter 填成相邻章节（±1~2）"。`validateExtractionOutput` 失败时会用同一容错匹配在【本批其余章节】里定位该 evidence（`locateEvidenceInBatch`），错误信息追加"**定位：该 evidence 实际可在第 X 章原文中找到——如第 X 章原文：…snippet…**"，让模型直接把 chapter 改对（若知识确实最早在声明章节揭晓，则改用该章逐字原句）。只做诊断定位，代码仍**绝不静默改 chapter**；
- **Evidence 错误一次性收集（打地鼠根治之一）**：`validateExtractionOutput` 不再"遇到第一条 evidence 错误就抛"——它把本批**全部** evidence 错误收集进 `errors[]`，最后 `errors.join("\n\n")` 一次性抛给反馈循环。这样一轮重试就能修完所有错误，而不是"一次只修一条、下一轮才暴露下一条"（21 章大批次常有 5~10 条 evidence 错误，逐个修会耗尽重试次数）。结构错误（缺 name/type/value、type 非法、chapter 越界、confidence 非法、kind 非法等）仍即时抛（其中 `newEntities.type` 由 `buildValidationFeedback` 扫描原始输出一次点名所有非法条目）；
- **重试把上一次输出回传给模型（打地鼠根治）**：ValidationError 重试时，pipeline 把上次尝试的完整输出 JSON 一并下发（`ExtractionInput.previousOutput`），prompt 明确要求模型**只修改被点名的记录、其余逐字不动**——避免每次重试都从头重新生成整份 JSON、把其他本来正确的记录改坏（例如第 1 次尝试 evidence 已正确、重试后反而被改坏）。JSON 解析失败/截断时上次输出不可用，不下发；
- **JSON 解析失败 / 输出截断也回填 feedback**（`pipeline.ts`）：模型输出无法解析（常见：JSON 前后混入解释/思考/推理文字、**中文全角逗号/冒号当结构标点**、用 `[...]`/`{...}`/「同上」等省略占位代替未修改记录）或达到输出上限被截断（模型"思考叙述"吃预算）时，`buildFixInstruction` 给出对应定向提示（禁前言文字 / 半角标点 / 禁省略占位 / 精简输出），让重试真正会修。
- **JSON 提取的容错与形状守卫**（`llm/openai.ts` 的 `extractJson` + `build/validation.ts` 的 `isExtractionRootObject`）：
  - `extractJson` 自动修复**字符串外的全角结构标点**（，：；→ , : ;；字符串内容不动）——模型把中文标点当 JSON 分隔符是最常见语法错误；
  - 修复后仍失败时，退路逐 `{` 配对尝试，取**最大跨度且通过 accept 谓词**的候选；accept 谓词要求候选是"抽取 JSON 根对象"（含 `newEntities/relations/abilities/events/memoryAnchors/possibleDuplicates/conflicts` 任一数组字段，或 ≥3 个数组型抽取字段）——**防止退路把单个实体/能力条目、`search_existing_entities` 工具回显等嵌套对象片段当成整批输出**（旧行为会导致整批静默抽空却标记 done，数据丢失级 bug）；校验器入口同样有该形状守卫，双层拦截；
- **代码绝不静默改写/丢弃模型输出**（这是与"宽容修复"方案明确区分的设计决定）；若重试耗尽仍失败 → 批次响亮失败并记录原因。
- 校验硬规则示例：`newEntities.type` 只允许 `character|organization|location|item|concept`，能力/技能禁止作为实体类型（能力走 `abilities` 数组）。

### Evidence Grounding / Provenance（P0：Reveal Chapter 归因）
- **问题**：旧 Build 里 LLM 正确理解"闻人佑负责做饭"，却把 chapter 填成 384（原文实际 396/397）、拉板车填成 391（原文 392）。Validator 只查 `start<=chapter<=end`，拦不住这种 **Temporal Attribution Error**。
- **方案**：`chapter/fromChapter/firstSeenChapter` 不再是"LLM 凭记忆填的数字"，而是必须带 `evidence`（该章原文短引），由 `validateExtractionOutput` 用**当前 Batch 章节原文**做确定性验证（`evidenceInChapter`：normalize 后严格 substring，或对 ≤40 字短证据做近字容错 / 同句少量省略匹配）。校验失败 → 反馈回 LLM 修正（不静默改 chapter）。反馈会带**拼接/未找到诊断**（`diagnoseEvidenceMismatch`）：片段在该章出现但不连续 → 提示跨句拼接需改为单句连续原文；完全找不到 → 提示总结/改写/编造或章节号填错；并带**定位提示**（`locateEvidenceInBatch`）：evidence 若实际存在于本批其他章节，直接点名该章节与原文片段，让模型改对 chapter。
- **normalize 规则**（`validation.ts`）：NFKC（全角→半角）→ 移除所有标点/符号 → 移除所有空白（含换行）→ 小写 → 优先 substring；容错层（`nearMatch` 子串编辑距离 ≤ max(1, len/10) 字、`gapSequenceMatch` 子序列省略 ≤ 12 字/段 ≤ 16 字全程、evidence 侧改写 ≤ 2 字）。不做 embedding/模糊语义验证。
- **最早证据**：同一 evidence 若在本 Batch 更早章节也出现，产生**非致命 warning**（提示 chapter 可能不是最早 Reveal Chapter，建议改用更早章节 evidence），不失败。
- **evidence 是否持久化**：**否**。evidence 是原文片段，只存在于 Build 数据流（内存校验），**不写入 Story DB、不进任何 Reader-facing API**——这是"Reader 永远不能访问小说原文"硬约束的结构性保证（web `/api/entity` 全行序列化也不会泄漏）。可观测性：mainline 每批记录 `evidenceValidated`（带 evidence 记录数）与 `evidenceWarnings`。

### 可观测性
- **主线/索引日志**：`.story/logs/build/mainline.jsonl`（`build/session-log.ts` 的 `BuildMainlineLogger`）——跨多次构建的追加式索引，一行一个事件，把每批 build 情况串成一根主线：
  - `run_start`：一次构建开始（provider/model/范围/批量策略/断点跳过数）；
  - `batch`：每批一行 —— 区间/状态/产出统计（实体/别名/事实/关系/能力/事件/锚点/重复）/token/耗时/重试次数/失败原因/本批摘要 + **`evidenceValidated`/`evidenceWarnings`**（Evidence Grounding 校验统计）+ **关联的 `session-*.jsonl` 完整轨迹文件路径**；
  - `run_end`：构建结束（总耗时/成败统计/跳过数/token 合计）。
  - 构建结束命令行（`story build` 与 TUI `/build` 面板）会打印 `runId`，据此在 mainline.jsonl 中定位本次构建。
- **会话日志**：Agent 化抽取时每批完整轨迹（prompt/回复/工具调用/usage）落盘 `.story/logs/build/session-<时间戳>-<range>.jsonl`（`build/session-log.ts`）；
- **性能指标**：`llm_logs` → `buildMetrics("extract")` 汇总 千字速度 / 千字 token / 缓存命中率 / 预估费用（`config.resolveLlmPrices` + `costEstimate`）。

### Character Recall / Evidence 回归测试（`scripts/recall-test.ts`）
- 需要真实 LLM + 已有完整 Story DB：在 `test/.e2e/recall-proj` 复制完整 DB（不动真实项目）→ 清理闻人佑旧数据 → 用新版抽取重建 361~405（**证据化抽取建议小批**：固定 5 章/批、retries≥6、failFast=false，否则单批几十条记录难以全部 ground 正确）→ 验证闻人佑 Recall Data（拉板车/高大沉默/做饭/板着脸/教【念】）→ **验证 Reveal Chapter 归因（拉车→392/393、做饭→396/397、教念→399/400，旧错误 384/391 不存在）** → 验证 5 个"模糊回忆"问题经 `search_entities` 定位闻人佑 → 验证 userChapter=405 防剧透边界 + 完整 `story audit --chapter 405`。
- `node dist/scripts/recall-verify.js`：只对已重建的测试库做断言验证（数据层章节归因 + 5 问搜索），**不触发 LLM**。`node dist/scripts/recall-search-check.js` 只打印 5 问搜索结果。
- 运行：`node dist/scripts/recall-test.js`（在项目根）。

---

## 4. `story ask <问题>` — 仅基于结构化数据的无剧透问答

### 做什么
不读原文、只检索结构化数据、严格受 `userChapter` 过滤地回答"这人是谁/记得什么/有什么能力/什么关系"等记忆恢复问题；数据不足时明确回答"当前结构化数据不足以可靠回答这个问题"。

### 入口
```
cmdAsk(question, flags)
 ├─ provider = createProvider(...)          # openai | mock
 ├─ userChapter = --chapter N ?? cfg.userChapter（--chapter 一次性临时覆盖，不写配置）
 ├─ repo.setUserChapter(userChapter)        # 数据访问层过滤边界
 └─ 两条路径（二选一）
```

### 路径 A：Agent 驱动（LLM 模式 + provider 支持 `getAgentKit`）
```
askAgent(provider, repo, cfg, question)     # reader/agent.ts
 ├─ new Agent(pi-agent-core) + buildNovelTools(toolCtx)   # reader/tools.ts
 │     工具（全部只读结构化、受 userChapter 过滤）：
 │     search_entities / get_entity / list_abilities / get_relations / list_events /
 │     get_entity_index / get_progress / list_chapters / set_chapter_focus
 ├─ agent.steer() 注入"当前阅读进度第 N 章，不得提及之后内容"
 ├─ agent.prompt(question)                  # 流式输出 → stdout；无工具调用上限（见 §7）
 └─ 返回 answer + tokens → recordAskLog
```

### 路径 B：传统管道（无 Agent 支持 或 mock 模式）
```
answerQuestion({ repo, cfg, provider, mode, question })   # reader/answer.ts
 ├─ 1. 能力名预匹配：问题包含已知能力名 → 定位其 Owner 实体
 ├─ 2. Intent：classifyIntent(question)     # reader/intent.ts（启发式正则）
 │      RECALL_CHARACTER / LIST_ABILITIES / ABILITY_LOOKUP / CHARACTER_RELATION /
 │      CHARACTER_HISTORY / LAST_APPEARANCE / ENTITY_SEARCH / GENERAL_STRUCTURED_QA
 ├─ 3. 实体解析：searchEntities(repo, question, topK)   # reader/search.ts
 │      · 权重（Memory-first，绝不所有字段等权拼接）：
 │        - name 精确 100 / 别名精确同高 / name·别名包含 55；
 │        - **MemoryAnchor 是人物模糊召回的一等来源**：锚点/事实/关系都**逐条**独立打分
 │          （避免长文本拼接产生巧合匹配），核心信号是"内容二元组"重叠——两个字符都是实义字才算
 │          （过滤"的人/是谁/的是/负责/进行"等虚词/泛化词），再叠加**idf 稀有度权重**（做饭/板车/教念
 │          这类高识别度词组权重大于 负责/戏道 这类常见词组）；另加中文一元字重叠（8/字，扁平）抓换序
 │          paraphrase（如「拉很重的车上山」↔「拉着板车登上丑峰」）；
 │        - 上限：记忆锚点 95（略低于 name 精确）、身份/性格事实 90、关系 95（与锚点同档，靠命中内容二元组数量 tie-break 决出）、事件低权重；
 │        - **同分 tie-break 按来源优先级**：记忆线索 > 身份/性格事实 > 关系 > 事件 > 名称包含——
 │          即"记忆线索"是最可信的模糊回忆来源；
 │        - matchedVia 直接给出命中的那条线索（如「记忆线索：高大沉默，一路拉着装满戏台道具的板车」
 │          「关系：师兄妹 三师兄,教授【念】」），Reader Agent 因此知道候选为何被召回；
 │        - 性格/外貌/习惯（personality/appearance/habit/description）已并入搜索索引（此前仅身份类事实参与）；
 │        - 关系 detail 只归给"被点名"的一端（如「三师兄,教授【念】」归 闻人佑 而非 陈伶），
 │          支撑"教陈伶【念】的人是谁"这类以关系定位的回忆问题
 │      · "主角"关键词命中 → 主角提权
 ├─ 4. 弱命中兜底：LLM 模式无命中或分数过低 → 给 LLM 结构化实体索引（buildEntityIndexDigest）做二次消歧
 ├─ 5. 构造上下文 buildContext → StructuredContext（reader/context.ts）
 │      EntityCard = 别名 + 身份/性格事实 + RecallAnchor（reader/recall.ts 排序：importance/
 │      memorability/主角相关性/最近性 加权）+ 关系 + 近期事件
 ├─ 6. 充分性判断：
 │      · 无任何命中 → 不足
 │      · 属性性问题（"最喜欢什么颜色"）且上下文不覆盖 → 不足
 ├─ 7. 回答：LLM：ASK_SYSTEM_PROMPT（注入 userChapter）+ StructuredContext JSON → provider.complete
 └─ recordAskLog → llm_logs(phase=ask)
```

### 防剧透实现（Ask 的核心约束）
- **数据访问层过滤**：`StoryRepo.setUserChapter(n)` 后，所有读方法（`listEntities / findEntityByName / findByAlias / getEntity / listFacts / listRelations / listAbilities / listEvents / listMemoryAnchors / listAppearances / listChapterMeta`）只返回 `chapter / first_seen_chapter / from_chapter <= n` 的数据；未来实体"存在本身"也表现为不存在。
- **Ask 代码路径上不存在原文**：`chapters` 表只有 Build/`src/cli/commands/import.ts` 能读；`scripts/e2e.ts` 有静态检查（`src/reader|src/cli/tui` 不得出现 `getChapterText`/`FROM chapters` 等）。
- TUI 切换章节（`/chapter N`）会 **reset Agent 会话**，防止未来数据经对话上下文泄露。

### TUI 问答呈现（app.ts / askAgent）
- 呈现顺序对齐 pi code agent：**用户输入 → 工具调用逐条（🔧 调用 / ✓ 完成）→ 最终回答在最后**流式输出。
- 工具调用 start 与 end 时都会把正在渲染的回答移到流底部（模型可能同轮"先答后调工具"，保证工具行聚在一起、回答永远在最后）。
- 非流式 / 推理模型（如 glm 把回答塞进 `reasoning_content`）的兜底：`message_end` 只把最终消息的文本/thinking **记录下来不立即渲染**，agent 结束后仍无流式文本时才用它当回答（避免中间消息/推理内容提前出现在工具调用之前）。
- 模型始终未返回文本时，诊断信息会带上**工具调用统计**（次数/失败数/失败工具名）帮助定位；系统提示词（`system-prompt.ts` 规则 8）要求工具调用带合法参数、失败后重试或基于已有数据回答、绝不返回空回复。
- **空回答二次机会**（app.ts / askAgent）：模型做过工具调用却未返回任何文本（含最后消息兜底）时，追加一条明确指令要求它直接基于已检索数据回答或明确说数据不足（禁止再调工具、禁止空内容）——把"查到了却忘了总结"的常见情况自动救回。
- **无工具调用上限**：不做 MAX_TOOL_TURNS 之类的硬限制（曾有过，会误伤"列举 top N"类需要逐个查询的问题）。单题内模型可自由调工具，靠上下文窗口自然收敛；超长循环的风险由 ask-log 观测（`.story/logs/ask/`）兜底。
- **回答质量**：系统提示词（`system-prompt.ts` 回答风格）对列举/概览类问题（"有哪些神道/技能"）要求分组精炼、不全量罗列、不用分隔线；TUI markdown 主题把 `hr`（`---`）渲染成轻量 `· · ·` 分隔点，避免满屏横线。

### Ask 会话日志（排查用）
- 每轮 Ask（TUI 问答 与 `story ask`）把 agent 事件落盘 `.story/logs/ask/session-<时间戳>.jsonl`（`src/reader/ask-log.ts` 的 `AskSessionLogger` + `logAskEvent`）：用户问题、每条助手消息（text / thinking / toolCalls / stopReason）、工具调用参数与结果、最终答案、耗时与工具统计。
- 用途：排查模型空回答 / 卡住 / 工具调用异常——直接看模型每轮到底输出了什么（text 还是 thinking、是否真为空）。
- 只记录结构化数据与对话文本，**不落盘 chapters 原文**（符合原文隔离硬约束）。
- TUI 里"⏳ 思考中…"每 3s 更新一次已等待秒数，避免误以为卡死。

---

## 5. 关键设计原则速查（改这块代码前必读）

1. **Build 可读原文，Ask/TUI/Agent 绝不读原文** —— 职责物理隔离，不是靠 prompt。
2. **防剧透边界 = `userChapter` 数据访问层过滤**，与导入范围无关。
3. **校验不过不写库**：任何抽取输出必须过 `validateExtractionOutput`，否则不进事务。
4. **校验错误的修复 = 反馈给 LLM**（`feedback` + `buildFixInstruction`），代码不得静默改写/丢弃模型输出。
5. **能力/技能不是实体类型**：`ENTITY_TYPES` 仅 `character|organization|location|item|concept`。
6. **`story init <文件>` 会清空全部旧数据**（更换小说 = 用新文件重跑 init）；build 的 `failed` 批次不会被跳过，重跑自动重试。
7. **三个概念不要混**：`availableThrough`（导入到哪）/ `builtThrough`（构建到哪）/ `userChapter`（读到哪）。
8. **MemoryAnchor = 记忆线索（不是剧情摘要）**：Build 侧它是"读者忘记人物名字后拿来重新定位他的画面/行为/特征"，`importance`（剧情重要度）与 `memorability`（记忆识别度）是两回事；Reader 侧它是人物模糊召回的一等数据源（见 §4 搜索权重）。Schema 用 `kind` 标记线索类型（visual/behavior/habit/interaction/role/quote），旧数据兼容为 NULL。
9. **Reveal Chapter 必须有证据**：任何影响 Reader Reveal Time 的 `chapter/fromChapter/firstSeenChapter` 都必须带 `evidence`（该章原文短引），由校验器对当前 Batch 原文做确定性验证（normalize 后严格 substring + 近字/少量省略容错，见 §3 Evidence Grounding）。校验失败 → 反馈 LLM 修正；反馈会带**定位提示**（evidence 实际所在章节 + 原文片段）帮助模型改对 chapter，但**代码绝不静默改 chapter，也不自动搜索全 Batch 偷偷修正**。evidence 是 Compiler provenance，不入库、不进 Reader。

---

## 6. TUI 界面化命令（/settings /login /logout）

靠齐 pi code agent。`/settings`、`/login`、`/build` 打开时通过 `setLayoutRoot` 用「顶栏 + 聊天历史 + 面板」重建布局根——**只把输入区（editor/bottomBar）替换为面板，顶栏和聊天历史保留可见**（不是整屏接管），关闭时还原基座布局并把焦点还给输入框。面板自身不画冗余标题（组件底部自带操作提示）。实现全部在 `src/cli/tui/menus.ts`，命令入口/补全在 `src/cli/tui/commands.ts`（`SLASH_COMMANDS` 注册），切换能力由 `app.ts` 经 `CommandContext.ui` 注入（`openSettings` / `openLogin` / `openBuild`；`MenuDeps` 携带 `topBar`/`scrollView`/`layoutRoot`/`focusTarget`）。注意：切换发生在 `onSubmit` 完成之后（`setTimeout(0)`），避免被末尾的 `setFocus(editor)` 抢走焦点；`/settings`/`/login`/`/build` 属 UI 命令（`UI_COMMANDS`），`CommandResult.noEcho=true`，**不在聊天区回显命令与结果**。

### `/settings` — 交互式设置菜单（输入区替换为面板）
- `openSettingsView(tui, deps)` 用 pi-tui `SettingsList` 组件渲染**通用配置**（reader.userChapter + build.*，**不含 llm.**——LLM 连接归 `/login`，凭据清除归 `/logout`）。
- Enter/Space 修改：数字走 `Input` 子菜单（子菜单内校验数字合法性），布尔（autoBatch / sessionLog）走 `values` 循环；`/` 启用搜索过滤；Esc 返回聊天视图。
- 每次改动立即 `saveConfig` 写 `.story/config.json`；`userChapter` 即时生效（`repo.setUserChapter` + 工具上下文 + `agent.reset()` 清历史防泄露）。

### `/login` — 引导式 LLM 连接向导
- `openLoginView(tui, deps)` 把输入区替换为自定义 `LoginWizard` 面板，分步：`baseUrl` → `apiKey` → `model` → `thinkingFormat` → `contextWindow` → `maxTokens` → **测试连接** → **保存并完成**；Esc 返回。`thinkingFormat` 用 Enter 循环切换 `auto|deepseek|zai|qwen|openrouter|openai`（glm 系选 `zai`、deepseek 系选 `deepseek`；`auto` 自动识别）；`contextWindow`/`maxTokens` 正整数才写入 config（留空回落环境变量/默认），作为 Build 批次预算与 API `max_tokens`（大上下文模型按实际填，如 1048576/384000）。
- 测试连接：用当前输入合并出临时 config → `createProvider(cfg)` → `provider.complete([…], { stream:false, reasoning:"off" })`，成功显示模型名与回复、失败显示错误；连接信息不完整则提示将用 mock。
- 保存：写入 `cfg.llm.{baseUrl,apiKey,model,thinkingFormat}` 并 `saveConfig`；留空项删除（回退环境变量）；保存后调用 `onLlmChanged`（app.ts 的 `reloadLlm`）**重建 provider/agent 并实时换入，无需重启**；完成后摘要经 `onNotify` 渲染到聊天区。
- 语义：环境变量 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL` 始终优先于 config（`resolveLlmSettings`），`/login` 只是把连接写进 config。
- **推理协议（glm 空回答问题）**：`src/llm/openai.ts` 的 `deepseekCompat` 会把 glm 系模型自动识别为 `thinkingFormat=zai` —— pi-ai 在 zai 格式下默认发送 `thinking:{type:"disabled"}`，模型回答才落在 `content`（否则 glm 会把整段回答塞进 `reasoning_content`、`content` 为空导致 Agent 拿不到文本）。另在 `app.ts` / `askAgent` 加了安全网：最终消息 `content` 为空时用 `thinking` 块兜底当回答。

### `/logout` — 清除已保存的 LLM 连接凭据
- `clearLlmConnection(cfg)` 删除 `llm.baseUrl / llm.apiKey / llm.model`（保留价格与推理参数），`saveConfig` 后调用 `ctx.ui.reloadLlm()` 实时重建（回到离线/mock 模式），返回摘要。
- 环境变量中的凭据不受影响。

### `/build` — 独立构建面板
- `case "build"`（`src/cli/tui/commands.ts`）打开 `openBuildView`（`menus.ts`）构建面板，把输入区替换为面板：进度条/百分比、失败批次数、实时 token 消耗 + ETA、当前批次运行日志实时渲染；**构建中不能干别的，Esc 取消**（pipeline `runBuild` 新增 `signal` 选项，批间检查、当前批结束后停止），完成后 Esc 返回。
- **进度条长度随面板/终端宽度自适应**（`BuildPanelHandle.width()`），并实时显示本次构建累计 token 消耗（`buildMetrics("extract")` 快照差量）。
- 面板复用原有进度与汇总 markdown 格式化；`/build` 属 UI 命令（`UI_COMMANDS`），`CommandResult.noEcho=true`，**聊天区零痕迹**（无回显、无「执行中…」）；**结束后面板显示简洁版结果（避免长表格溢出），完整批次明细经 `ctx.onNotify` 输出到聊天区**（聊天区可滚动查看，关闭面板后仍有记录）。
- `/build` 各 flag（`--from/--to/--force/--batch-size/--auto-batch/--keep-going`）与配置组 `build.*` 的语义不变（`build.retries` 同样生效：`/settings` 改 `build.retries` 即改 `/build` 重试次数，与 CLI `story build` 一致）。

### 实时生效说明
- `reader.userChapter`、`build.*`：本身就被 `/ask` `/build` 等实时读取，改动即时生效。
- `llm.*`（provider/agent）：`/login` 保存与 `/logout` 后通过 `reloadLlm`（app.ts）重建 provider + agent（`createProvider` → `createStoryAgent`）并换入运行中的应用，**全程无需重启 TUI**。

---

## 7. Reader Agent 设定与运行机制（Ask 的 Agent 路径）

Ask 的 Agent 路径 = **系统提示词（`src/reader/system-prompt.ts`） + 工具集（`src/reader/tools.ts`） + Agent 组装（`src/reader/agent.ts`）**，全部在 `src/reader/*`（不读原文、只读结构化数据、受 `userChapter` 过滤）。

### 系统提示词：`buildAgentSystemPrompt(cfg)`（`src/reader/system-prompt.ts`）
生成后被设成 pi-agent-core `Agent` 的 `systemPrompt`，每次 `agent.prompt` 都在上下文中。结构：

- **角色**：小说阅读记忆助手，帮读者回忆小说《书名》中的人物/情节。
- **核心约束（8 条）**：
  1. 只能根据工具检索到的 STRUCTURED STORY DATA 回答；
  2. 不能用模型自身关于这部小说的知识（数据里没有就答"数据不足"）；
  3. 绝不能访问小说原文；
  4. 不能编造章节号/能力/事实/关系；
  5. 阅读进度由 `get_progress` 返回的 `userChapter` 决定，不确定先调用确认；
  6. 超过 `userChapter` 的信息不存在于检索结果，不要提及/推测；
  7. 严格基于检索到的结构化数据，数据里没有的不要用自己的知识补；
  8. **工具调用必须带合法参数**（如 `search_entities` 需 `query`、`get_entity` 需 `name`；`list_abilities`/`list_events` 的 `entity_name` 可省略但参数对象不能缺）；工具失败 → 用正确参数重试、或基于已有数据回答、或明确说"数据不足"，**绝不返回空回复**。
- **工作流程**：先调工具检索 → 分析 → 能答给简明答案 / 不能答明确说数据不足。
- **工具使用指南**：每种问法对应哪个工具（模糊描述→`search_entities`，是谁→`get_entity`，能力→`list_abilities`，关系→`get_relations`，最近事件→`list_events`，有哪些人→`get_entity_index`，读到哪→`get_progress`，章节名→`list_chapters`，限定章节范围→`set_chapter_focus`）。
- **回答风格**：中文简洁、不复述过程、不编造、引用"第 X 章"、列举类问题分组精炼不全量罗列不用分隔线、可提示追问。

### 工具集：`buildNovelTools(toolCtx)`（`src/reader/tools.ts`）
全部**只读结构化数据、受 `userChapter` 过滤**（TypeBox 参数 schema + execute；`toolCtx` 携带 repo/book/availableThrough/userChapter/focus）。共 9 个：

| 工具 | 作用 | 参数 |
|---|---|---|
| `search_entities` | 按描述/特征模糊搜实体（外号、身份定位、记忆线索召回——「做饭的三师兄」「拉板车的人」） | `query`（必）、`topK`（可选 ≤10） |
| `get_entity` | 取实体完整档案（身份/性格/锚点/关系/事件/出场） | `name`（必） |
| `list_abilities` | 列某实体能力（或全书，按 focus 过滤） | `entity_name`（可选） |
| `get_relations` | 查实体关系（单实体全部 / 双实体之间） | `entity_a`（必）、`entity_b`（可选） |
| `list_events` | 列重要事件（可按实体/章节区间过滤） | `entity_name`/`from_chapter`/`to_chapter`/`limit`（均可选） |
| `get_entity_index` | 全书实体总览（类型/别名/首出场/出场次数/身份 + 关系清单） | `topN`（可选 ≤50） |
| `get_progress` | 工作区信息（书名/进度/availableThrough/builtThrough/主角/数据量） | 无 |
| `list_chapters` | 列章节标题 | `from_chapter`/`to_chapter`/`limit` |
| `set_chapter_focus` | 设定检索焦点章节区间（复用 `toolCtx.focus`） | `from`/`to` |

未命中实体时工具返回可读提示（如"不存在名为…的实体，可先 search_entities 确认"），不让模型瞎猜。

### Agent 组装与运行（`src/reader/agent.ts`）
- **`createStoryAgent(model, streamFn, repo, cfg, toolCtx)`**：TUI 用，创建一个可跨问题复用的 `Agent`；`model`/`streamFn` 来自 `provider.getAgentKit()`（pi-ai 底座）。每次 `agent.prompt(question)` 完成一轮问答，消息历史跨问题保留（`/chapter` 会 `agent.reset()` 清历史防泄露）。
- **`askAgent(provider, repo, cfg, question, callbacks)`**：CLI `story ask` 用，单题；`callbacks.onToken/onToolCall/onToolResult/onDone` 驱动流式输出。
- **未配置 LLM**：TUI 仍可启动（agent 为 null），问答路径提示"请 `/login` 配置"；`/login` 保存后经 `reloadLlm` 创建真实 agent。
- 每题 `agent.prompt` 前 `agent.steer()` 注入一条 `[系统提示] 当前阅读进度：第 N 章…`（防剧透边界提示，数据过滤仍是 `repo.setUserChapter`）。
- **无工具调用上限**：单题内模型可自由调工具（靠上下文窗口自然收敛）；超长循环由 ask-log 观测。
- 工具执行事件（`tool_execution_start/end`、`message_update`、`message_end`）被 app.ts / askAgent 订阅 → 驱动 TUI 渲染与 ask-log（见 §4"TUI 问答呈现"与"Ask 会话日志"）。

### 与 Build 抽取 Agent 的区别
| | Reader Agent（Ask） | 抽取 Agent（Build） |
|---|---|---|
| 读什么 | 结构化数据（无原文） | 章节原文 |
| 产出 | 自然语言回答 | 结构化 JSON bundle |
| 工具 | 9 个只读检索工具 | 1 个 `search_existing_entities` |
| 过滤 | 受 `userChapter` | 不过滤（读全部） |
| 工具上限 | 无 | 无（都靠上下文窗口自然收敛） |
| 日志 | `.story/logs/ask/*.jsonl` | `.story/logs/build/*.jsonl` |

---

## 8. `story web` — 本地小说百科网站

### 做什么
在本地起一个**零框架 Node HTTP 服务**，把已构建的结构化知识以网页形式呈现：首页实体分类索引、实体详情档案（事实/能力/关系/高光时刻/事件/出场分布）、模糊搜索。核心卖点是**阅读进度过滤的防剧透百科**：网页顶部可拖动滑块调整 `userChapter`，所有页面内容随之收窄——未出场的角色「存在本身」都不显示。

### 实现路径
```
cmdWeb(flags)                           # src/cli/commands/web.ts
 ├─ 校验 .story/config.json 存在（否则报错提示先 story init）
 └─ startWebServer({ port, host, cwd, quiet })     # src/web/server.ts
     ├─ node:http createServer（127.0.0.1:8765 默认，--port/--host 覆盖）
     ├─ API（全部 GET，每个请求 new StoryRepo → setUserChapter(n) 过滤）：
     │    /api/state?chapter=N    元信息：book / availableThrough / builtThrough /
     │                            主角（guessProtagonist）/ 当前进度下可见数据量
     │    /api/index?chapter=N    实体分类索引（首页：tagline=身份类事实、别名、首/末出场）
     │    /api/entity?name=X      实体档案：实体行 + 别名 + 事实 + 能力 + 关系（双向，
     │                            对方实体会因过滤而不存在）+ 事件（参与者展开名字）+
     │                            记忆锚点 + 出场分布（章节/提及数）
     │    /api/search?q=X         复用 src/reader/search.ts 的 searchEntities（同 Ask 的模糊搜索）
     └─ 静态文件：项目根 web/（index.html / style.css / app.js —— 零框架 hash 路由 SPA）
```

### 关键点
- **防剧透 = 数据访问层**：服务端每个请求 new 一个 `StoryRepo` 并 `setUserChapter(n)`，与 Ask/Reader 走**完全同一条过滤层**；前端（`web/app.js`）只渲染服务端返回的数据，不参与过滤判断。
- **原文隔离**：服务端只使用 Reader 安全方法（`listChapterMeta` 拿章节标题等），**不读 chapters 正文、不暴露正文**；`src/web/*` 不在 e2e 静态检查路径上，但遵守同一约束。
- 默认进度 = `config.userChapter`（默认 1，保守）；前端滑块范围 1..builtThrough，选择记忆在 `localStorage`。
- 无新增依赖、无前端构建链（`node:sqlite` + `node:http` + 原生 JS）；`story web` 前台常驻，Ctrl+C 停止。
- 出错可观测：请求日志 `[web] METHOD path status ms`（`--quiet` 关闭）。
