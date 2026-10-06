/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// ログイン方法（authMethod）による分岐は、api-permissions.ts の規則の表と適用処理だけに置く。
// ルートの中で分岐すると、入力チェックより後ろの分岐は api-key-routes.test.ts の比較では見つからないため、ソースで止める。
const sources = import.meta.glob(["../**/*.ts", "!../test/**", "!../**/*.test.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// 書き方（c.get / c.var / 分割代入など）によらず見逃さないよう、単語が現れるファイルで判定する
const allowedAuthMethodFiles = [
  "../env.ts", // 型の定義
  "../middleware/auth.ts", // 認証の解決で設定する
  "../routes/auth-cli.ts", // /auth/cli でセッションとして設定する
  "../middleware/api-permissions.ts", // ログイン方法の規則の表と適用
  "../middleware/security-audit.ts" // 監査記録に残すだけで、許可・拒否には使わない
];

// apiKeyId は、監査記録の実行者と、長いアップロードの途中でキーが取り消されていないかの再確認だけに使う
const allowedApiKeyIdFiles = [
  "../env.ts",
  "../middleware/auth.ts",
  "../routes/auth-cli.ts", // 発行したキーを認証要求に結び付ける
  "../db/cli-auth.ts",
  "../middleware/security-audit.ts",
  "../routes/api-v1/deploy-batches.ts",
  "../routes/api-v1/deploy-service-account.ts"
];

// Authorization ヘッダーやセッションを直接読むと、ルートの中でブラウザとAPIキーを見分けられてしまう。
// 認証の解決と /auth/* の処理だけに限る
const allowedCredentialReaders = [
  "../auth/session.ts",
  "../index.ts",
  "../middleware/api-permissions.ts",
  "../middleware/auth.ts",
  "../routes/auth-cli.ts"
];

describe("auth method usage", () => {
  it("mentions the auth method only in authentication and the login method rules", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(30);
    const files = Object.entries(sources).filter(([, source]) => /\bauthMethod\b/.test(source)).map(([path]) => path).sort();
    expect(files).toEqual([...allowedAuthMethodFiles].sort());
  });

  it("reads credentials directly only where authentication is resolved", () => {
    const pattern = /header\(\s*["']Authorization["']|getStoredSession|getActiveSessionUser|sessionReference/;
    const readers = Object.entries(sources).filter(([, source]) => pattern.test(source)).map(([path]) => path).sort();
    expect(readers).toEqual([...allowedCredentialReaders].sort());
  });

  // app.all() などメソッドを問わない登録は、ルート比較のtestで use と区別できず対象から漏れるため使わない
  it("does not register handlers for all methods", () => {
    const registrations = Object.entries(sources).filter(([, source]) => /\b(app|[A-Za-z]+Route)\.all\(/.test(source)).map(([path]) => path);
    expect(registrations).toEqual([]);
  });

  it("mentions the API key id only for auditing and revocation re-checks", () => {
    const files = Object.entries(sources).filter(([, source]) => /\bapiKeyId\b/.test(source)).map(([path]) => path).sort();
    expect(files).toEqual([...allowedApiKeyIdFiles].sort());
  });
});
