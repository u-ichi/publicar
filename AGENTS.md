# publicar 指示

- アプリ本体・テスト・マイグレーションはこの公開リポジトリで管理する。本番設定と本体配備は運用者の非公開リポジトリで管理する。作業前に対象の `git remote -v` を確認する。

- 日本語で簡潔に報告すること。
- Cloudflare Workers / Hono / R2 の既存構成に沿い、最小差分で変更すること。
- 認証・署名・HTML 配信に関わる変更では、入力検証と XSS/権限境界を明示的に確認すること。
- 変更後は `npm run typecheck` と `npm test` を実行し、Workers runtime の変更は `npm run dev` でも確認すること。

## ローカル開発環境

- `npm run dev` → `wrangler dev` → http://localhost:8787
- `.dev.vars` に OAuth 情報・暗号化キーが設定済み（`.dev.vars.example` がテンプレート）
- D1/KV/R2 は miniflare がローカルで自動管理（外部サービス不要）
- マイグレーションは `wrangler dev` 起動時に自動適用
- Google OAuth はローカルバイパスなし。localhost:8787 用 OAuth クライアントが設定済み
- `DEV_MODE=true` により TEAM_DRIVE_ID なしでもデプロイ API が動作する

### 動作確認手順

1. `npm run dev` でサーバー起動
2. `curl http://localhost:8787/health` → `{"ok":true,"devMode":true}` を確認
3. ブラウザで http://localhost:8787 → ログイン画面が表示されることを確認

wrangler が見つからない場合は `npx wrangler --version` で確認（devDependency としてインストール済み）。

詳細: [docs/local-development.md](docs/local-development.md)
