# publicar セットアップガイド

[README](../README.md) / [日本語 README](../README.ja.md) / [ローカル開発ガイド](local-development.md) / [Google OAuth セットアップガイド](google-oauth-setup.md) / [社外コラボレーターの招待](external-collaborators.md)

自組織向けの publicar インスタンスを Cloudflare にデプロイする手順。

## 前提条件

- Node.js 20 以上
- [Cloudflare アカウント](https://dash.cloudflare.com/sign-up)（Workers の有料プラン推奨）
- Google Workspace の組織アカウント
- Google Shared Drive（ファイルの永続保存に使用）

## 1. リポジトリのクローン

```bash
git clone https://github.com/u-ichi/publicar.git
cd publicar
npm install
```

## 2. Cloudflare リソースの作成

Wrangler CLI でリソースを作成する。

```bash
npx wrangler login

# D1 データベース
npx wrangler d1 create publicar
# → 出力される database_id を控える

# KV Namespace（セッション管理用）
npx wrangler kv namespace create SESSIONS
# → 出力される id を控える

# R2 バケット（ファイルキャッシュ用）
npx wrangler r2 bucket create publicar-cache
```

## 3. Google OAuth の設定

[Google OAuth セットアップガイド](google-oauth-setup.md) に従って、OAuth 2.0 クライアントを作成し、Client ID と Client Secret を取得する。

OAuth の「対象」は **「外部 / 本番環境」** を選ぶ (社外コラボレーターをプロジェクト単位で招待できるようにするため。組織内に閉じる運用なら「内部」)。招待の運用は [社外コラボレーターの招待](external-collaborators.md) を参照。

## 4. Google Shared Drive の準備

1. Google Drive で Shared Drive を作成（または既存のものを使用）
2. Shared Drive を開き、URL から Drive ID を取得:
   `https://drive.google.com/drive/folders/<DRIVE_ID>`
3. publicar を利用するユーザーに Shared Drive への書き込み権限を付与

## 5. 設定ファイルの作成

### wrangler.toml

```bash
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` を編集し、手順 2〜4 で取得した値を設定する:

| 項目 | 設定する値 |
|------|-----------|
| `GOOGLE_CLIENT_ID` | OAuth Client ID |
| `ALLOWED_SIGNUP_DOMAINS` | 組織のメールドメイン（例: `example.com`） |
| `TEAM_DRIVE_ID` | Shared Drive の ID |
| `database_name` / `database_id` | 手順 2 の D1 作成時の出力 |
| `id` (KV) | 手順 2 の KV 作成時の出力 |
| `bucket_name` | 手順 2 の R2 バケット名 |

### .dev.vars（ローカル開発用）

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` を編集し、以下を設定:

| 項目 | 値 |
|------|-----|
| `GOOGLE_CLIENT_ID` | OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth Client Secret |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` で生成 |
| `SESSION_SECRET` | `openssl rand -base64 32` で生成 |
| `ALLOWED_SIGNUP_DOMAINS` | 組織のメールドメイン |

## 6. D1 マイグレーションの適用

```bash
# ローカル（開発用）
npx wrangler d1 migrations apply publicar --local

# リモート（本番用）
npx wrangler d1 migrations apply <your-d1-database-name> --remote
```

## 7. ローカル開発

```bash
npm run dev
# http://localhost:8787 でアクセス
```

## 8. 本番デプロイ

### Secret の設定

`GOOGLE_CLIENT_SECRET`、`TOKEN_ENCRYPTION_KEY`、`SESSION_SECRET` を Cloudflare の暗号化 Secret として設定する:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put SESSION_SECRET
```

### デプロイ

```bash
npm run deploy
```

## 9. カスタムドメイン（任意）

1. Cloudflare Dashboard で Workers → publicar → 「設定」→「ドメインとルート」
2. カスタムドメインを追加
3. `wrangler.toml` の `[[routes]]` セクションのコメントを外してドメインを設定
4. Google OAuth の承認済みリダイレクト URI にカスタムドメインの `/auth/callback` を追加
5. 再デプロイ: `npm run deploy`

## GitHub Actions CI/CD（任意）

リポジトリの GitHub Actions で自動デプロイを設定する場合:

1. GitHub リポジトリの Settings → Secrets and variables → Actions に以下を追加:
   - `CLOUDFLARE_API_TOKEN`: Cloudflare API トークン（Workers 編集権限 + D1 編集権限）
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare アカウント ID
2. `.github/workflows/ci.yml` が main ブランチへの push で自動デプロイを実行
