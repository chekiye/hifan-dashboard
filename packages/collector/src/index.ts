export * from './client.js';
export * from './collector.js';
export * from './fixnames.js';
// §79 定期更新检测 —— 从主入口 re-export，
// ⛔ 不新增子路径 exports：autoupdate.ts 走 "@hifan/collector" 单一入口，
//    避免 package.json exports 与 dist 目录结构两处维护（0lx：判据多处拷贝）。
export * from './hanime_scan.js';
export * from './hanime_diff.js';
// §85 直链选链规则（唯一实现：抓取脚本与服务器重抓共用）
export * from './link_pick.js';
// §79-2 匹配层 TS 移植（唯一事实来源仍是 scripts/match_core.mjs，靠对拍守一致）
export * from './match_core.js';