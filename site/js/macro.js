// 總經 8 格（新聞頁 v4）：每格一個數字＋一句白話「代表什麼／對你」。數字都來自 market-data，句子照固定規則產生，
// 只描述方向，不預測漲跌。AI 寫的總結等新聞晨報 v4 再加。
import { loadMeta, loadFx, loadMarketInsti } from "./data.js";
import { isNum, price, pct, tone, shortDate } from "./fmt.js";

const LIGHT = { 紅: "熱絡", 黃紅: "轉向熱絡", 綠: "穩定", 黃藍: "轉向低迷", 藍: "低迷" };
const yi = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v / 1e8).toLocaleString("zh-TW", { maximumFractionDigits: 0 })} 億`;

export async function macroTiles() {
  const [metaR, fxR, instR] = await Promise.allSettled([loadMeta(), loadFx(), loadMarketInsti()]);
  const ds = metaR.status === "fulfilled" ? metaR.value.datasets || {} : {};
  const missing = (name) => ({ name, missing: true });

  // 美股指數、原油、殖利率：最後一天與前一天收盤
  const last2 = (key) => {
    const d = ds[key];
    return d && isNum(d.last_close) && isNum(d.prev_close) ? d : null;
  };
  const index = (key, name, text) => {
    const d = last2(key);
    if (!d) return missing(name);
    const c = (d.last_close / d.prev_close - 1) * 100;
    return { name, date: `${shortDate(d.last)} 收盤`, value: price(+d.last_close.toFixed(2)), change: pct(c, 2), tone: tone(c), text: text(c) };
  };
  const dir = (c, up, down) => (c >= 0 ? up : down);

  const tiles = [
    index("macro/SOX", "費城半導體", (c) => `${dir(c, "漲", "跌")} ${Math.abs(c).toFixed(1)}%。半導體的溫度計；你的 009816、00981A 都重壓半導體。`),
    index("macro/SPX", "標普 500", (c) => `美股大盤${dir(c, "上漲", "下跌")}；你的 VOO 就是追蹤它。`),
  ];

  const tnx = last2("macro/TNX");
  tiles.push(tnx ? (() => {
    const bp = Math.round((tnx.last_close - tnx.prev_close) * 100);
    return { name: "美國 10 年債殖利率", date: `${shortDate(tnx.last)} 收盤`, value: `${tnx.last_close.toFixed(2)}%`,
      change: `${bp >= 0 ? "+" : "−"}${Math.abs(bp)} 個基點`, tone: "flat",
      text: bp === 0 ? "利率持平。" : `利率${dir(bp, "上升：股票（尤其成長股）的評價壓力變大", "下降：股票（尤其成長股）的評價壓力減輕")}。` };
  })() : missing("美國 10 年債殖利率"));

  const fx = fxR.status === "fulfilled" && fxR.value.length >= 2 ? fxR.value : null;
  tiles.push(fx ? (() => {
    const a = fx.at(-2).value, b = fx.at(-1).value, d = b - a;
    return { name: "美元兌台幣", date: `${shortDate(fx.at(-1).date)} 收盤`, value: b.toFixed(3),
      change: `台幣${d > 0 ? "貶" : d < 0 ? "升" : "持平"} ${Math.abs(d).toFixed(3)}`, tone: "flat",
      text: d > 0 ? "台幣變弱：你的美股部位換成台幣變多；外資匯出時台幣常會貶。" : d < 0 ? "台幣變強：你的美股部位換成台幣變少。" : "匯率持平。" };
  })() : missing("美元兌台幣"));

  tiles.push(index("macro/WTI", "WTI 原油", (c) => `油價${dir(c, "上漲：通膨與利率的壓力增加", "下跌：通膨壓力減輕")}。`));
  const wti = tiles.at(-1);
  if (!wti.missing) wti.tone = "flat"; // 油價漲跌不代表好壞，不上紅綠

  // 外資：最後一天的買賣超、連續幾天同方向、投信
  const inst = instR.status === "fulfilled" ? instR.value : null;
  tiles.push(inst ? (() => {
    const last = inst.at(-1), sell = last.foreign < 0;
    let n = 0, sum = 0;
    for (let i = inst.length - 1; i >= 0 && (inst[i].foreign < 0) === sell && inst[i].foreign !== 0; i--) {
      n += 1;
      sum += inst[i].foreign;
    }
    return { name: "外資（台股集中市場）", date: shortDate(last.date), value: yi(last.foreign), change: sell ? "賣超" : "買超", tone: tone(last.foreign),
      text: `${n > 1 ? `連 ${n} 天${sell ? "賣超" : "買超"}，合計 ${yi(sum)}` : `今天${sell ? "賣超" : "買超"}`}；投信${last.trust >= 0 ? "買超" : "賣超"} ${yi(last.trust).replace(/^[+−]/, "")}。` };
  })() : missing("外資（台股集中市場）"));

  const bc = ds["longterm/tw_business_cycle"];
  tiles.push(bc && isNum(bc.last_score) ? {
    name: "景氣燈號（國發會）", date: `${Number(bc.last.slice(5))} 月`, value: `${bc.last_score} 分 ${bc.last_light}燈`, tone: "flat",
    text: `景氣${LIGHT[bc.last_light] || bc.last_light}${bc.next_release_est ? `；下次公布約 ${shortDate(bc.next_release_est)}` : ""}。`,
  } : missing("景氣燈號（國發會）"));

  const bf = ds["longterm/buffett_indicator"];
  tiles.push(bf && isNum(bf.last_ratio_pct) ? {
    name: "巴菲特指標（美國）", date: bf.last, value: `${bf.last_ratio_pct.toFixed(0)}%`, tone: "flat",
    text: `股市總市值／GDP，${bf.last_dev_sigma >= 0 ? "高" : "低"}於長期趨勢 ${Math.abs(bf.last_dev_sigma).toFixed(1)} 個標準差：美股估值${bf.last_dev_sigma >= 1 ? "偏高" : bf.last_dev_sigma <= -1 ? "偏低" : "接近長期趨勢"}。`,
  } : missing("巴菲特指標（美國）"));

  const failed = [metaR, fxR, instR].filter((r) => r.status === "rejected").map((r) => r.reason?.source || r.reason?.message);
  return { tiles, failed };
}
