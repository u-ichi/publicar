# サービスアカウントによる自動アップロード

GitHub Actionsなどの自動処理には、プロジェクトに所属するアップロード専用キーを渡します。publicarはGoogle Cloudのサービスアカウントで共有ドライブへ保存します。自動処理の実行に、個人のGoogle更新トークンや追加のGoogle Workspaceユーザーは使いません。

## 二つの認証情報

| 認証情報 | 保持する場所 | 許可する範囲 |
|---|---|---|
| publicarのアップロードキー（`upl_`） | GitHub Secretsなどの実行環境 | 登録された一つのプロジェクトの `POST /api/v1/projects/:id/deploy` |
| Googleサービスアカウントの秘密鍵 | Cloudflare WorkerのSecret | Googleでそのサービスアカウントに共有した保存先 |
| 人のログインセッション | 管理画面のブラウザ | 所有者など、その利用者に与えられた管理操作 |

アップロードキーからは、記事取得、他のプロジェクトへの更新、公開設定変更、メンバー管理、キー発行、プロジェクト削除を実行できません。キーは発行者個人の権限を引き継ぎません。発行者が無効化されても、プロジェクトのキーは有効期限または取消まで存続します。

キーを取得した人は、そのプロジェクトの記事を差し替えられます。Googleの秘密鍵を取得した人は、publicarのAPIを経由せずGoogle側の権限を使えます。Workerの配備・Secret管理権限を持つ管理者も、この秘密鍵へアクセスできる立場です。Googleの秘密鍵をGitHub Actionsへ渡さないでください。

アップロードキーによる制限はAPIの操作範囲です。投稿HTMLの内容や実行するJavaScriptの安全性を保証する機能ではありません。

## 保存先とGoogleの設定

1. Google CloudプロジェクトでDrive APIを有効にし、publicar用のサービスアカウントを作成します。人のアカウントを代理操作するドメイン全体の委任は設定しません。
2. Google Workspaceの組織ポリシーで、サービスアカウントの鍵作成と対象保存先の共有が許可されていることを確認します。禁止されている場合は、設定を広げたり人の認証へ切り替えたりせず、管理者が方針を確認します。
3. `TEAM_DRIVE_ID` 内のpublicar保存フォルダだけをサービスアカウントへ共有します。ファイルの追加・読取・編集・ゴミ箱移動が必要です。実際の操作可否はGoogleが返す `canAddChildren`、`canDownload`、`canEdit`、`canTrash` で確認します。共有ドライブの `fileOrganizer`（コンテンツ管理者）は内容の整理とゴミ箱移動を行う役割です。
4. 新しいプロジェクトのフォルダも自動作成する場合は、専用の親フォルダを `GOOGLE_SERVICE_ACCOUNT_ROOT_FOLDER_ID` に指定し、そこへ必要な権限を付与します。同じ共有ドライブ内で追加権限があることを作成前に確認します。共有ドライブ全体がpublicar専用である場合だけ、そのルートを明示指定できます。既存のプロジェクトフォルダを使用する場合、この親フォルダ設定は不要です。
5. Workerへ次の設定を渡します。メールアドレスと秘密鍵は `wrangler secret put`、ローカルではGit管理対象外の `.dev.vars` を使います。

| 設定 | 内容 |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | サービスアカウントのメールアドレス |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | ダウンロードした認証情報の `private_key`。PKCS#8 PEM形式 |
| `TEAM_DRIVE_ID` | 保存先の共有ドライブ |
| `GOOGLE_SERVICE_ACCOUNT_ROOT_FOLDER_ID` | 新規プロジェクトの保存フォルダを作成する親フォルダ。新規作成時に必要 |

既存ファイルも扱うため、Googleの認証スコープは `https://www.googleapis.com/auth/drive` を使用します。スコープの名前だけで会社全体のDriveへアクセスできるわけではなく、実際の対象はGoogleの共有権限で決まります。不要なフォルダや共有ドライブをサービスアカウントへ共有しないでください。

Googleトークンの発行先はGoogleの固定URLです。JWTの署名にRS256を使い、ユーザーの代理実行を指定する `sub` は送りません。短期トークンはWorker内で更新し、クライアントへ返しません。

資料: [Googleサービスアカウントの認証](https://developers.google.com/identity/protocols/oauth2/service-account)、[Driveのスコープ](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、[共有ドライブとサービスアカウント](https://developers.google.com/workspace/drive/api/guides/about-shareddrives)、[Driveの役割](https://developers.google.com/workspace/drive/api/guides/ref-roles)、[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

## プロジェクトを有効化する

所有者がプロジェクト詳細の「自動アップロード」を開き、キーの名前と未来の有効期限を指定します。APIでは次の操作です。

- `POST /api/v1/projects/:id/upload-keys`：`name` とUTCの `expires_at` を指定して発行。
- `GET /api/v1/projects/:id/upload-keys`：メタデータを取得。原文とハッシュは返しません。
- `DELETE /api/v1/projects/:id/upload-keys/:keyId`：指定キーを取り消す。

この操作には所有者のログインセッションが必要です。別サイトからのブラウザ操作要求と、APIキーによる操作は拒否します。Googleログインの開始情報は、開始したブラウザのCookieに結び付けます。

最初のキー発行時に、既存フォルダとファイルへサービスアカウントでアクセスできることを確認します。フォルダがなければ、明示された専用の親フォルダ内に作成します。旧方式による更新・削除が実行中なら切替を拒否し、切替中は旧方式の保存操作を開始できません。処理が異常終了して参加情報だけが残った場合は、最長10分で再試行可能になります。

確認が成功したプロジェクトだけをサービスアカウント方式に切り替えます。以後は、そのプロジェクトの手動更新、キャッシュ再取得、整理、Driveの共有操作にも同じサービスアカウントを使います。Googleの権限不足や認証失敗時に、人の更新トークンへ切り替える処理はありません。Driveでの共有操作には、保存操作とは別に必要な共有権限があることを確認してください。

キー原文は256ビットの乱数から生成し、一度だけ表示します。D1にはハッシュだけを保存します。原文はGitHub Secretsなどへ保存し、画面から非表示にしてください。有効期限は必須で、自動延長しません。

環境へサービスアカウントの設定を追加しただけでは、他のプロジェクトの保存方式を変更しません。既存の個人APIキーを一括失効・自動変換する移行も行いません。

## アップロードと再試行

アップロードキーを `Authorization: Bearer upl_...` で送り、`Idempotency-Key` に実行ごとの識別子を指定します。識別子は英数字と `._:-` の1～128文字です。キー原文をURLへ入れないでください。

- `?path=index.html`：指定パスの単一ファイルを更新します。`path` 省略時は、その実行で読み取った本文入口を使います。
- `?name=site.zip`：ZIPの内容でファイル一覧全体を置換します。含まれないパスは新しい公開版から外れます。
- 同じプロジェクト・キー・要求ID・内容の再送は、元の成功結果を返します。後続の更新があっても元の結果を返し、過去の内容を再公開しません。
- 同じ要求IDで内容や明示したパスなどを変えると `409 idempotency_conflict` です。新しい更新には新しい要求IDを使います。

新しいDriveファイルとR2オブジェクトを保存した後、配信する版、ファイル一覧、成功履歴、再試行結果をD1で一括確定します。既存ファイルを転送途中で上書きしません。確定時にはキーの取消・期限、プロジェクト、更新開始時の版を再確認します。競合した更新は `409`、取り消されたキーは `401` で失敗し、現在の記事を保持します。公開設定やメンバーはアップロード処理から変更しません。

| 制限 | 既定値 |
|---|---|
| 受信容量 `MAX_UPLOAD_BYTES` | 5MiB |
| ZIP展開後の合計 `MAX_EXPANDED_UPLOAD_BYTES` | 20MiB |
| ZIP内の項目数 `MAX_UPLOAD_FILES` | 200（ディレクトリ・メタデータも計数） |
| 保存処理の公開確定期限 | 5分 |
| Google書込要求の待機上限 | 60秒 |

受信とZIP展開は、全量を保持する前に上限を判定します。不正なパス、正規化後の重複パス、本文入口のないZIPを拒否します。

「未公開」はpublicarの配信対象でないという意味です。Driveフォルダ自体への共有権限がある人には、準備中や旧版のファイルが見える場合があります。

Workers Freeで多数のファイルを更新する場合は、[分割送信API](free-plan-uploads.md)を使用します。開始時に一覧と15分の固定期限を保存し、一件ずつの送信後に公開を確定します。キー発行画面は既存ファイルを一件ずつ確認し、202の間は準備を続け、201でキーを表示します。

## GitHub Actions

[送信ステップの例](examples/organization-deploy-step.yml)を、文書生成後のjobへ追加します。

- Variables：`PUBLICAR_ENDPOINT`、`PUBLICAR_PROJECT_ID`
- Secret：管理画面で発行した `PUBLICAR_DEPLOY_KEY`
- 成果物：例では `dist/docs.zip`

例は `main` へのpush時だけ送信します。同じstep内の通信再試行は同じ要求IDとファイルを使用します。GitHubのjobを再実行すると `GITHUB_RUN_ATTEMPT` が変わるため、新しい更新として扱います。

Secretを使用できるworkflowを変更できる人は、対象の記事を更新できる立場として扱います。キーの名前が見えることと原文を取得できることは別ですが、workflowの変更権限からSecretが使用される処理を変えられる点に注意してください。

## 記録、整理、停止

成功履歴には、プロジェクト、アップロードキーID、サービスアカウント、成果物のハッシュ、版を記録します。人の発行者と自動更新の実行者を分けて表示します。`X-Publicar-Repository`、`X-Publicar-Commit`、`X-Publicar-Run-Id` は呼出側の申告で、認可やGitHub由来の証明には使いません。

キー原文、Google秘密鍵、Googleアクセストークンを監査記録へ保存しません。監査の保存期間は `SECURITY_LOG_RETENTION_DAYS`、既定90日です。

未完成・未参照ファイルは1時間以上経過してから、毎分の定期処理で整理します。1回あたりファイルとフォルダを合計5件まで処理します。現行のファイル一覧が参照するものは残します。GoogleやR2の失敗時は整理対象を残し、5分後から再試行します。新方式で作った実体は操作識別子と保存先を照合し、不一致なら削除しません。`upload_cleanup_pending`、`folder_cleanup_pending` と、`upload_objects` のうち現行 `project_files` から参照されない残件を監視してください。継続的に処理能力を超える利用では、実行頻度・処理量を見直します。

キーの取消は新しい受付と公開確定を止めます。すでに公開された記事を削除する操作ではありません。外部へ送信済みの要求がGoogle側で実行されなかったことまでは保証できず、そのファイルは整理対象になります。

交換時は新キーを発行し、利用先を切り替えて主要動作を確認してから旧キーを取り消します。Googleの鍵を交換する場合も同じサービスアカウントの新しい鍵をWorkerへ反映し、確認後に旧鍵を削除します。鍵削除だけで発行済み短期トークンまで直ちに失効するとは扱わず、漏洩時はサービスアカウント停止と保存先の共有取消を含めて対応します。[Googleの鍵削除](https://docs.cloud.google.com/iam/docs/keys-create-delete)

## 移行と確認

`0011_organization_security.sql` と `0012_service_account_uploads.sql` は、既存プロジェクト、ファイル、メンバー、成功履歴を保持します。個人キーの期限や取消状態を勝手に書き換えません。既に取り消したキーは取り消したままです。旧CLIの未完了認証要求は移行で破棄されるため、CLI側から認証をやり直します。

D1のバックアップを取り、対応するWorkerとマイグレーションを組み合わせて反映します。サービスアカウント有効化後に旧Workerだけへ戻すと、保存実行者と版の扱いが合わないため、Workerだけを旧方式へ戻さないでください。

ローカル検証:

```sh
npm run typecheck
npm test -- --run
scripts/dev-runtime.sh start
scripts/dev-runtime.sh health
```

実Googleとの確認は、本番記事と分離した確認用フォルダで行います。`scripts/verify-service-account.mjs` はまず設定と権限を読み取り、`--write` を指定した場合だけ確認用ファイルを作成・読取・ゴミ箱移動します。`.dev.vars` または環境変数に必要な認証情報を設定し、`PUBLICAR_VERIFY_FOLDER_ID` に確認用フォルダを指定します。原文の鍵を引数やチャットへ貼り付けないでください。

```sh
node scripts/verify-service-account.mjs
node scripts/verify-service-account.mjs --write
```

確認対象は、Googleの鍵作成可否、実際のフォルダ権限、保存・読取・整理、R2を空にした後の再取得、取消後の拒否です。ローカルのダミー認証によるテスト成功と、実Googleへの接続成功を区別します。
