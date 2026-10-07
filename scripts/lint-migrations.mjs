// マイグレーションの最後の文が ; で終わっているかを確かめる。
// wrangler d1 migrations apply は本文の後ろに適用記録の INSERT をつなげて実行するため、; がないと構文エラーになる。
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../migrations/", import.meta.url);
const failures = readdirSync(dir)
  .filter(name => name.endsWith(".sql"))
  .filter(name => {
    const body = readFileSync(new URL(name, dir), "utf8")
      .split("\n")
      .filter(line => !/^\s*--/.test(line))
      .join("\n")
      .trim();
    return !body.endsWith(";");
  });

if (failures.length) {
  for (const name of failures) console.error(`migrations/${name}: 最後の文が ; で終わっていません`);
  process.exit(1);
}
