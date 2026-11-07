// CSV 解析（RFC 4180：引號、欄位內換行、兩個引號代表一個引號）。報告全文欄有換行，不能用 split。

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// 有表頭的 CSV → 物件陣列（略過全空白列）
// rowKey：在每一列加上它在試算表裡的列號（表頭是第 1 列，中間的空白列也算），例如記帳頁沖銷要指定第幾列
export function parseTable(text, rowKey = null) {
  const [header, ...rows] = parseCSV(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return rows
    .map((r, i) => [r, i + 2])
    .filter(([r]) => r.some((v) => v.trim() !== ""))
    .map(([r, n]) => {
      const o = Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()]));
      if (rowKey) o[rowKey] = n;
      return o;
    });
}

// 顯示後的數字 → number：去掉千分位、貨幣符號、百分比；空白或無法解析回傳 null
export function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/NT\$|US\$|[$,%\s]/g, "").replace(/[−–]/g, "-");
  if (s === "" || s === "-" || s === "—") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
