# Google OAuth セットアップガイド

[README](../README.md) / [日本語 README](../README.ja.md) / [セットアップガイド](setup.md) / [ローカル開発ガイド](local-development.md)

publicar の認証に必要な Google OAuth 2.0 クライアントの作成手順。

## 前提条件

- Google Cloud プロジェクト（Google Workspace 組織のアカウントで作成）
- Google Cloud Console へのアクセス権

## 手順

### 1. Google Cloud プロジェクトの作成

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. プロジェクトセレクタから「新しいプロジェクト」を作成（名前は任意、例: `publicar`）

### 2. OAuth 同意画面の設定

1. 「APIとサービス」→「OAuth 同意画面」を開く
2. User Type: 「内部」を選択（組織内ユーザーのみ利用する場合）
3. 必須項目を入力:
   - アプリ名: `publicar`
   - ユーザーサポートメール: 管理者のメールアドレス
   - デベロッパーの連絡先: 同上
4. スコープの追加:
   - `openid`
   - `email`
   - `profile`
   - `https://www.googleapis.com/auth/drive.file`

### 3. OAuth クライアントの作成

1. 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアント ID」
2. アプリケーションの種類: 「ウェブ アプリケーション」
3. 名前: `publicar` (任意)
4. 承認済みのリダイレクト URI を追加:
   - 本番: `https://<your-domain>/auth/callback`
   - ローカル開発: `http://localhost:8787/auth/callback`
5. 「作成」をクリック

### 4. 認証情報の取得

作成後に表示される以下の値を控える:

- **クライアント ID** → `GOOGLE_CLIENT_ID` に設定
- **クライアント シークレット** → `GOOGLE_CLIENT_SECRET` に設定

### 5. Google Drive API の有効化

1. 「APIとサービス」→「ライブラリ」を開く
2. 「Google Drive API」を検索して有効化

## 設定先

| 値 | ローカル開発 | 本番 |
|----|-------------|------|
| `GOOGLE_CLIENT_ID` | `.dev.vars` と `wrangler.toml` の `[vars]` | `wrangler.toml` の `[vars]` |
| `GOOGLE_CLIENT_SECRET` | `.dev.vars` | Cloudflare Dashboard の Secrets |

本番環境では `GOOGLE_CLIENT_SECRET` を Cloudflare Dashboard の Workers 設定 →「変数と Secrets」から暗号化 Secret として設定してください（`wrangler.toml` には書かない）。
