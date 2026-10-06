/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// ログイン方法（authMethod）による分岐は、認証のミドルウェアだけに置く。
// ルートの中で分岐すると、入力チェックより後ろの分岐は api-key-routes.test.ts の比較では見つからないため、ソースで止める。
const sources = import.meta.glob(["../**/*.ts", "!../test/**", "!../**/*.test.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const allowedAuthMethodReaders = [
  "../middleware/session-security.ts",
  // 監査記録に認証方法を残すだけで、許可・拒否には使わない
  "../middleware/security-audit.ts"
];

// apiKeyId は、監査記録の実行者と、長いアップロードの途中でキーが取り消されていないかの再確認だけに使う
const allowedApiKeyIdReaders = [
  "../middleware/security-audit.ts",
  "../routes/api-v1/deploy-batches.ts",
  "../routes/api-v1/deploy-service-account.ts"
];

describe("auth method usage", () => {
  it("reads the auth method only in authentication middleware", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(30);
    const readers = Object.entries(sources).filter(([, source]) => /get\(\s*["']authMethod["']\s*\)/.test(source)).map(([path]) => path).sort();
    expect(readers).toEqual([...allowedAuthMethodReaders].sort());
  });

  it("reads the API key id only for auditing and revocation re-checks", () => {
    const readers = Object.entries(sources).filter(([, source]) => /get\(\s*["']apiKeyId["']\s*\)/.test(source)).map(([path]) => path).sort();
    expect(readers).toEqual([...allowedApiKeyIdReaders].sort());
  });
});
