import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(".story/story.db");
console.log("== 能力表：名称含 左轮/盗 的能力 ==");
for (const r of db.prepare("SELECT name, entity_id, chapter, summary FROM abilities WHERE name LIKE '%左轮%' OR name LIKE '%盗%'").all()) {
  console.log(" ", JSON.stringify(r));
}
console.log("== 事实：value 含 左轮/盗神道 ==");
for (const r of db.prepare("SELECT entity_id, type, value, chapter FROM facts WHERE value LIKE '%左轮%' OR value LIKE '%盗神道%' ORDER BY chapter").all()) {
  console.log(" ", JSON.stringify(r));
}
console.log("== 关系：type 或 detail 含 盗 ==");
for (const r of db.prepare("SELECT from_entity, to_entity, type, detail, chapter FROM relations WHERE type LIKE '%盗%' OR detail LIKE '%盗%' ORDER BY chapter LIMIT 12").all()) {
  console.log(" ", JSON.stringify(r));
}
// 用户进度 919 时可见的最大章节
const vis = db.prepare("SELECT MAX(chapter) m FROM facts WHERE chapter <= 919").get();
console.log("进度 919 可见的事实最大章:", vis.m);
db.close();