// 新版本全书重跑统计（聚合 2026-08-23T02:37UTC 之后所有 benchmark 片段，含失败与看门狗重启）+ 与旧版基线对比
import fs from "node:fs";

const BOOK_START = new Date("2026-08-23T02:37:00Z");
const lines = fs.readFileSync(".story/logs/build/mainline.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
let batches = 0, done = 0, failed = 0, attempts = 0, durMs = 0, evWarnings = 0, evValidated = 0, chars = 0;
const tokens = { input: 0, cached: 0, output: 0 };
const failedRanges = [];
for (const l of lines) {
  const o = JSON.parse(l);
  if (o.kind !== "batch") continue;
  if (new Date(o.ts) < BOOK_START) continue;
  batches++;
  if (o.status === "done") done++;
  else if (o.status === "failed") { failed++; failedRanges.push(o.range); }
  attempts += o.attempts ?? 1;
  durMs += o.durationMs ?? 0;
  tokens.input += o.tokens?.input ?? 0;
  tokens.cached += o.tokens?.cached ?? 0;
  tokens.output += o.tokens?.output ?? 0;
  chars += o.chars ?? 0;
  evWarnings += o.evidenceWarnings ?? 0;
  evValidated += o.evidenceValidated ?? 0;
}
const price = { input: 8, output: 24, cached: 1.6 };
const costCalc = (u, c, o) => (u * price.input + c * price.cached + o * price.output) / 1e6;
const cur = {
  batches, done, failed, failedRanges,
  attemptsPerBatch: +(attempts / Math.max(1, batches)).toFixed(2),
  durationMin: Math.round(durMs / 60000),
  chars,
  tokens,
  tokensTotal: tokens.input + tokens.output,
  costYuan: +costCalc(tokens.input - tokens.cached, tokens.cached, tokens.output).toFixed(1),
  evWarnings,
  evValidated,
};
const base = JSON.parse(fs.readFileSync(".story/logs/build/BASELINE-before-grounding.json", "utf8"));
console.log("== 旧版本基线（整书实际总花费，含失败重跑）==");
console.log(JSON.stringify({ ...base, costYuan: +costCalc(base.tokens.input - base.tokens.cached, base.tokens.cached, base.tokens.output).toFixed(1) }, null, 1));
console.log("== 新版本（关键短语接地，基准重跑截至当前）==");
console.log(JSON.stringify(cur, null, 1));
console.log("== 对比 ==");
const pct = (a, b) => a === 0 ? "n/a" : ((b / a - 1) * 100).toFixed(1) + "%";
console.log("总token(输入+输出):", base.tokensTotal.toLocaleString(), "→", cur.tokensTotal.toLocaleString(), `(${pct(base.tokensTotal, cur.tokensTotal)})`);
console.log("尝试/批:", base.attemptsPerBatch, "→", cur.attemptsPerBatch);
console.log("失败批:", base.failed, "→", cur.failed, "(最终重跑后应=0)");
console.log("费用估算(¥):", +(costCalc(base.tokens.input - base.tokens.cached, base.tokens.cached, base.tokens.output)).toFixed(1), "→", cur.costYuan);