# publicar

HTML レポートを共有 URL で配信するセルフホスト型サービス。Cloudflare Workers で動作する。

組織内のメンバーに Google OAuth 認証付きで安全に共有できる。

## 主な特徴

- **Google OAuth 認証** — ドメイン制限でアクセス制御
- **HTML / ZIP デプロイ** — 単一ファイルまたは CSS/JS/画像を含む ZIP をアップロード
- **API キー認証** — `pub_...` 形式のキーで CLI / エージェントから操作
- **AI エージェント連携** — `/llms.txt` + `/api/v1/openapi.json`
- **AI コメントループ** — 公開 URL のコメントに対する AI 返信案と HTML 修正案を、別 repo の `publicar-skill` plugin から支援
- **GUI 管理画面** — プロジェクト一覧・詳細・メンバー管理・ファイル管理

## クイックスタート

```bash
git clone https://github.com/u-ichi/publicar.git
cd publicar
npm install
cp .dev.vars.example .dev.vars
# .dev.vars を編集して Google OAuth の値を設定
npm run dev
# http://localhost:8787 でアクセス
```

Docker を使う場合:

```bash
cp .dev.vars.example .dev.vars
docker compose up --build
# http://localhost:8787 でアクセス
```

## デプロイ

自組織向けインスタンスのセットアップ手順は **[セットアップガイド](docs/setup.md)** を参照。

Google OAuth の設定は **[Google OAuth セットアップガイド](docs/google-oauth-setup.md)** を参照。

## API

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/llms.txt` | AI エージェント向けサービス説明 |
| `GET` | `/api/v1/openapi.json` | OpenAPI 3.1.0 仕様 |
| `POST` | `/api/v1/projects` | プロジェクト作成 |
| `GET` | `/api/v1/projects` | プロジェクト一覧 |
| `GET` | `/api/v1/projects/{id}` | プロジェクト詳細 |
| `PATCH` | `/api/v1/projects/{id}` | プロジェクト更新 |
| `DELETE` | `/api/v1/projects/{id}` | プロジェクト削除 |
| `POST` | `/api/v1/projects/{id}/deploy` | ファイルデプロイ |
| `GET` | `/api/v1/api-keys` | API キー一覧 |
| `POST` | `/api/v1/api-keys` | API キー発行 |
| `DELETE` | `/api/v1/api-keys/{id}` | API キー削除 |
| `GET` | `/auth/cli` | CLI 認証フロー開始 |
| `GET` | `/auth/cli/poll` | CLI 認証ポーリング |

## AI エージェント連携

Claude Code / Codex 用 plugin は独立 repo **publicar-skill** で管理する。plugin 側は publicar 本体の `/api/v1/openapi.json` を API 互換性の基準として利用する。

プラグイン未導入の場合も、API キーと curl で直接デプロイ可能:

```bash
curl -X POST https://your-domain/api/v1/projects/<id>/deploy?path=index.html \
  -H "Authorization: Bearer pub_..." \
  -H "Content-Type: text/html" \
  --data-binary @report.html
```

## 技術スタック

- **ランタイム**: Cloudflare Workers + [Hono](https://hono.dev/) (TypeScript)
- **データベース**: Cloudflare D1 (SQLite)
- **ストレージ**: Cloudflare R2
- **セッション**: Cloudflare KV
- **テスト**: Vitest + `@cloudflare/vitest-pool-workers`
- **CI/CD**: GitHub Actions

## 開発

```bash
npm run dev          # 開発サーバー起動
npm run typecheck    # 型チェック
npm test             # テスト実行
npm run deploy       # 本番デプロイ
```

## ライセンス

[Apache License 2.0](LICENSE)
