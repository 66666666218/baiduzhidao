"use strict";
/** 从分享页 HTML 提取 file_list JSON 数组（括号配对），供调试/兜底使用 */
function extractFileList(html) {
  const key = html.indexOf('"file_list":[');
  if (key < 0) return [];
  let i = key + '"file_list":'.length;
  const start = i;
  let depth = 0, inStr = false, esc = false;
  while (i < html.length) {
    const ch = html[i];
    if (esc) { esc = false; }
    else if (ch === "\\") { esc = true; }
    else if (ch === '"') { inStr = !inStr; }
    else if (!inStr) {
      if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          try {
            const arr = JSON.parse(html.slice(start, i + 1));
            return arr.map((f) => ({ path: f.path || "", server_filename: f.server_filename || "", isdir: Number(f.isdir) === 1 }));
          } catch { return []; }
        }
      }
    }
    i += 1;
  }
  return [];
}
module.exports = { extractFileList };
