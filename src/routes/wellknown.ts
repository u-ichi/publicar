import type { Context } from "hono";
import type { AppBindings } from "../env";

const LLMS_TXT = `# publicar

> HTML/ZIP をアップロードして共有 URL を発行する配信基盤。

## 認証

API キーを Authorization ヘッダーで送信する。

    Authorization: Bearer pub_...

API キーは Web UI のダッシュボードから発行するか、セッション認証済みの状態で POST /api/v1/api-keys を呼ぶ。

## クイックスタート

1. プロジェクト作成

    POST /api/v1/projects
    Content-Type: application/json
    Authorization: Bearer pub_...

    {"title": "my-report"}

2. HTML デプロイ

    POST /api/v1/projects/{id}/deploy?path=index.html
    Content-Type: text/html
    Authorization: Bearer pub_...

    <html>...</html>

3. ZIP デプロイ

    POST /api/v1/projects/{id}/deploy?name=site.zip
    Content-Type: application/zip
    Authorization: Bearer pub_...

    (ZIP バイナリ)

4. 共有 URL はデプロイレスポンスの url フィールドで返る。

## API 仕様

詳細は GET /api/v1/openapi.json を参照。

## エンドポイント一覧

- POST   /api/v1/projects             プロジェクト作成
- GET    /api/v1/projects             プロジェクト一覧
- GET    /api/v1/projects/{id}        プロジェクト詳細
- PATCH  /api/v1/projects/{id}        プロジェクト更新
- DELETE /api/v1/projects/{id}        プロジェクト削除
- POST   /api/v1/projects/{id}/deploy ファイルデプロイ
- GET    /api/v1/api-keys             API キー一覧
- POST   /api/v1/api-keys             API キー発行
- DELETE /api/v1/api-keys/{id}        API キー削除
`;

export function llmsTxt(c: Context<AppBindings>): Response {
  return c.text(LLMS_TXT, 200, { "Content-Type": "text/plain; charset=utf-8" });
}
