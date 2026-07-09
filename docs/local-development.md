# ローカル開発ガイド

[README](../README.md) / [日本語 README](../README.ja.md) / [セットアップガイド](setup.md) / [Google OAuth セットアップガイド](google-oauth-setup.md)

publicar のローカル開発環境の詳細リファレンス。

## 前提条件

- Node.js 20 以上
- `npm install` 実行済み
- `.dev.vars` が設定済み（`.dev.vars.example` をコピー）

`.dev.vars` は Google OAuth クライアント情報と暗号化キーを含む。このファイルは `.gitignore` に登録されており、リポジトリにはコミットされない。設定項目の詳細は `.dev.vars.example` と [docs/setup.md](setup.md) を参照。

## 起動方法

### npm（推奨）

```bash
npm run dev
# http://localhost:8787 でアクセス
```

Codex / Claude が dev runtime を起動・停止・health 確認する場合は、承認を細切れにしないために以下の wrapper を使う。

```bash
scripts/dev-runtime.sh start
scripts/dev-runtime.sh health
scripts/dev-runtime.sh stop
```

`.dev.vars` の `GOOGLE_REDIRECT_URI` が `https://publicar-local.example.com:8443/auth/callback` の場合は、Secure Cookie と OAuth callback のためにローカル HTTPS proxy 経由でアクセスする。

前提:

- `/etc/hosts` に `127.0.0.1 publicar-local.example.com` を設定する
- `publicar-local.example.com` 用のローカル証明書を用意する

起動例:

```bash
npm run dev -- --ip 127.0.0.1 --port 8787
node tmp/https-proxy.mjs
# https://publicar-local.example.com:8443 でアクセス
```

`tmp/https-proxy.mjs` と `tmp/certs/` はローカル補助ファイルで、リポジトリにはコミットしない。

### Docker

```bash
docker compose up --build
# http://localhost:8787 でアクセス
```

## ローカルリソース

`wrangler dev` (miniflare) がすべてのバインディングをローカルで自動管理する。Cloudflare アカウントや外部サービスへの接続は不要。

| バインディング | 本番 | ローカル |
|---------------|------|---------|
| `DB` (D1) | Cloudflare D1 | ローカル SQLite (`.wrangler/state/` 配下) |
| `SESSIONS` (KV) | Cloudflare KV | メモリ上 |
| `CACHE_BUCKET` (R2) | Cloudflare R2 | メモリ上 |

ローカルの D1 データベースをリセットしたい場合は `.wrangler/state/` ディレクトリを削除して再起動する。

## マイグレーション

`migrations/` ディレクトリに SQL マイグレーションファイルがある。

- `wrangler dev` 起動時に自動適用される
- 手動適用: `WRANGLER_LOG_PATH=tmp/wrangler-d1-migrations.log XDG_CACHE_HOME="$PWD/tmp/tool-cache" npx wrangler d1 migrations apply DB --local`

既存の `wrangler dev` を起動したまま migration を追加した場合など、ローカル D1 に新規 table が存在しないときは手動適用する。`DB` は `wrangler.toml` の D1 binding 名。

## 認証

ローカル開発でも Google OAuth による認証が必須（バイパス機能はない）。

- localhost:8787 用のリダイレクト URI (`http://localhost:8787/auth/callback`) または HTTPS proxy 用のリダイレクト URI (`https://publicar-local.example.com:8443/auth/callback`) が Google Cloud Console に登録済み
- `.dev.vars` の `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` に対応する OAuth クライアントが設定済み
- ブラウザで設定に対応する URL にアクセスし、Google ログインすると利用可能

OAuth クライアントの設定詳細は [docs/google-oauth-setup.md](google-oauth-setup.md) を参照。

## DEV_MODE

`.dev.vars` で `DEV_MODE=true` が設定されている。

| 機能 | 影響 |
|------|------|
| `isDriveConfigured()` | `TEAM_DRIVE_ID` が未設定でもデプロイ API が `503` を返さない (`src/routes/api-v1/deploy.ts`) |
| `/health` | レスポンスに `devMode: true` を含む |

DEV_MODE はデプロイ API のゲートチェックのみに影響する。認証・セッション・ファイル配信など他の機能に DEV_MODE 依存の分岐はない。

## 環境変数

`.dev.vars` で設定する環境変数の一覧。型定義は `src/env.ts` の `Env` 型を参照。

| 変数 | 必須 | 説明 |
|------|------|------|
| `DEV_MODE` | - | `true` で TEAM_DRIVE_ID なしでもデプロイ可 |
| `GOOGLE_CLIENT_ID` | 必須 | OAuth クライアント ID |
| `GOOGLE_CLIENT_SECRET` | 必須 | OAuth クライアントシークレット |
| `TOKEN_ENCRYPTION_KEY` | 必須 | トークン暗号化キー (base64) |
| `SESSION_SECRET` | 必須 | セッション署名キー (32文字以上) |
| `ALLOWED_SIGNUP_DOMAINS` | - | 許可ドメイン (カンマ区切り) |
| `GOOGLE_REDIRECT_URI` | - | リダイレクト URI (デフォルト: 動的構築) |
| `TEAM_DRIVE_ID` | - | Shared Drive ID (DEV_MODE=true なら省略可) |
| `DEFAULT_VISIBILITY` | - | 新規プロジェクトのデフォルト公開設定 |
| `MAX_UPLOAD_BYTES` | - | 最大アップロードサイズ (デフォルト: 5MB) |

テスト用のオーバーライド可能な URL 変数 (`GOOGLE_TOKEN_URL`, `GOOGLE_JWKS_URL` 等) は `src/env.ts` を参照。

## テスト

```bash
npm test          # vitest + @cloudflare/vitest-pool-workers
npm run typecheck # tsc --noEmit
```

テストは miniflare バインディングを使用し、Google API エンドポイントは環境変数でオーバーライドして mock する (`vitest.config.ts` 参照)。

## 動作確認チェックリスト

1. **型チェック**: `npm run typecheck`
2. **テスト**: `npm test`
3. **サーバー起動**: `scripts/dev-runtime.sh start`
4. **ヘルスチェック**: `scripts/dev-runtime.sh health` → `{"ok":true,"devMode":true}`
5. **ログイン画面**: ブラウザで http://localhost:8787 → ログインページが表示される

ステップ 3-5 は Workers の起動確認であり、特定 UI の動作確認ではない。UI の修正では、対象操作そのものをブラウザで確認する。ローカル D1/R2 に production project のデータが無く対象 URL が 404 になる場合、`/health` 成功だけで UI 修正を検証済み扱いにしない。

公開環境のセットアップ手順は [docs/setup.md](setup.md) を参照。

## トラブルシューティング

| 症状 | 原因と対処 |
|------|-----------|
| `wrangler: command not found` | `npx wrangler dev` で起動する。devDependency として node_modules にインストール済み |
| `.dev.vars` 関連のエラー | `.dev.vars.example` をコピーして値を設定する |
| D1 マイグレーションエラー | `.wrangler/state/` を削除して再起動 |
| OAuth リダイレクトエラー | `GOOGLE_REDIRECT_URI` が設定済みか、またはリクエスト URL からの動的構築で正しいか確認 |
