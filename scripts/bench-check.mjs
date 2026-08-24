// 监控：打印当前分离运行的进度（快速、无副作用）
import fs from "node:fs";
const lines = fs.readFileSync(".story/logs/build/mainline.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
const runs = lines.map((l) => JSON.parse(l)).filter((o) => o.kind === "run_start");
const rid = runs.length ? runs[runs.length - 1].runId : "?";
let done = 0, failed = 0, last = "", attempts = 0;
for (const l of lines) {
  const o = JSON.parse(l);
  if (o.kind === "batch" && o.runId === rid) {
    if (o.status === "done") done++;
    else if (o.status === "failed") failed++;
    last = o.range;
    attempts += o.attempts ?? 1;
  }
}
console.log(`run=${rid} done=${done} failed=${failed} last=${last} attempts/批≈${done ? (attempts / done).toFixed(2) : "-"}`);