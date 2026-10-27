// 今日計畫（製作中）
import { pageHeader, notice } from "../ui.js";

export async function render(root) {
  root.append(pageHeader("今日計畫"), notice("info", "這一頁還在製作中。"));
}
