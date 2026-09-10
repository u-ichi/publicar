import type { Context } from "hono";
import type { AppBindings } from "../../env";
import { apiKeyPermissions } from "../../middleware/api-permissions";

const SPEC = {
  openapi: "3.1.0",
  info: {
    title: "publicar API",
    version: "1.0.0",
    description: "HTML/ZIP を共有 URLで配信する API"
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      sessionAuth: { type: "apiKey", in: "cookie", name: "__Host-publicar_session", description: "Googleログイン。管理操作には直近15分以内のログインが必要" },
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "公開先・scope・期限を制限したAPIキー。管理操作には使用不可"
      },
      uploadKeyAuth: {
        type: "http", scheme: "bearer", description: "upl_で始まるプロジェクト所属のアップロード専用キー。指定プロジェクトのPOST deployだけに使用できる"
      }
    },
    schemas: {
      UploadKey: {
        type: "object", properties: {
          id: { type: "string" }, project_id: { type: "string" }, name: { type: "string" },
          created_by: { type: ["string", "null"], description: "キー発行者。Googleへの保存実行者とは異なる" },
          expires_at: { type: "string", format: "date-time" }, revoked_at: { type: ["string", "null"] }, created_at: { type: "string" }
        }
      },
      Project: {
        type: "object",
        properties: {
          id: { type: "string" },
          alias: { type: "string" },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          visibility: { type: "string", enum: ["private", "invite", "domain", "group", "link", "public"] },
          allowedDomains: { type: "array", items: { type: "string" } },
          allowedGroups: { type: "array", items: { type: "string" } },
          entryPath: { type: "string" },
          createdAt: { type: "string" },
          updatedAt: { type: "string" }
        }
      },
      ApiKey: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          keyPrefix: { type: "string" },
          scopes: { type: "array", items: { type: "string", enum: ["read", "write", "deploy"] } },
          lastUsedAt: { type: ["string", "null"] },
          createdAt: { type: "string" },
          expiresAt: { type: ["string", "null"] },
          projectId: { type: ["string", "null"] },
          automationGrantId: { type: ["string", "null"] },
          revokedAt: { type: ["string", "null"] }
        }
      },
      CommentThread: {
        type: "object",
        properties: {
          id: { type: "string" },
          projectId: { type: "string" },
          path: { type: "string" },
          author: { type: "object" },
          actorKind: { type: "string", enum: ["human", "ai"] },
          body: { type: "string" },
          anchor: { type: "object" },
          selectedText: { type: "string" },
          status: { type: "string", enum: ["open", "resolved"] },
          createdAt: { type: "string" },
          updatedAt: { type: "string" },
          replies: { type: "array", items: { $ref: "#/components/schemas/CommentReply" } }
        }
      },
      CommentReply: {
        type: "object",
        properties: {
          id: { type: "string" },
          threadId: { type: "string" },
          author: { type: "object" },
          actorKind: { type: "string", enum: ["human", "ai"] },
          body: { type: "string" },
          createdAt: { type: "string" }
        }
      },
      Notification: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["comment_created", "comment_replied"] },
          title: { type: "string" },
          body: { type: "string" },
          url: { type: "string" },
          readAt: { type: ["string", "null"] },
          createdAt: { type: "string" }
        }
      },
      Error: {
        type: "object",
        properties: {
          error: { type: "string" }
        }
      }
    }
  },
  security: [{ sessionAuth: [] }],
  paths: {
    "/api/v1/projects": {
      post: {
        summary: "プロジェクト作成",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title"],
                properties: {
                  title: { type: "string" },
                  description: { type: ["string", "null"] },
                  alias: { type: "string" },
                  visibility: { type: "string", enum: ["private", "invite", "domain", "group", "link", "public"] },
                  allowed_domains: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        responses: { "201": { description: "作成成功" } }
      },
      get: {
        summary: "プロジェクト一覧",
        responses: { "200": { description: "一覧取得成功。各 thread は処理履歴 events を含む" } }
      }
    },
    "/api/v1/projects/{id}": {
      get: {
        summary: "プロジェクト詳細",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "取得成功" } }
      },
      patch: {
        summary: "プロジェクト更新",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "更新成功" } }
      },
      delete: {
        summary: "プロジェクト削除",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "削除成功" } }
      }
    },
    "/api/v1/projects/{id}/deploy": {
      post: {
        summary: "ファイルデプロイ",
        description: "pathで単一ファイルを更新、name=*.zipでファイル一覧全体を置換する。サービスアカウントの保存では全ファイルを保存してから公開版を一括確定する。",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "path", in: "query", schema: { type: "string" }, description: "単一ファイルのパス" },
          { name: "name", in: "query", schema: { type: "string" }, description: "ZIP ファイル名 (*.zip)" },
          { name: "Idempotency-Key", in: "header", schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" }, description: "アップロード専用キーでは必須。同一プロジェクト・キー・要求IDの再送は同一内容の場合に確定済み結果を返す" }
        ],
        requestBody: {
          required: true,
          content: {
            "text/html": { schema: { type: "string" } },
            "application/zip": { schema: { type: "string", format: "binary" } }
          }
        },
        responses: { "200": { description: "公開確定または同一要求の確定済み結果。サービスアカウント保存ではrevision_idも返す" },
          "400": { description: "要求ID、パス、ZIPなどの入力が不正" }, "401": { description: "キーが無効・失効・期限切れ" },
          "403": { description: "対象または操作が許可されていない" }, "409": { description: "同時更新、または同一要求IDで異なる内容" },
          "413": { description: "受信・展開容量またはファイル件数の上限超過" }, "502": { description: "保存失敗。現在の公開版は維持する" }, "503": { description: "サービスアカウントの設定不足・不一致" } }
      }
    },
    "/api/v1/projects/{id}/review-content": {
      get: {
        summary: "レビュー対象HTML取得",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "path", in: "query", schema: { type: "string" } }
        ],
        responses: { "200": { description: "取得成功" } }
      }
    },
    "/api/v1/projects/{id}/comments": {
      get: {
        summary: "コメント一覧",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "path", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["open", "resolved", "all"] } }
        ],
        responses: { "200": { description: "一覧取得成功" } }
      },
      post: {
        summary: "コメント作成",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["path", "body", "anchor"],
                properties: {
                  path: { type: "string" },
                  body: { type: "string" },
                  anchor: { type: "object" },
                  actorKind: { type: "string", enum: ["human", "ai"], default: "human" },
                  selected_text: { type: "string" },
                  client_mutation_id: { type: "string" }
                }
              }
            }
          }
        },
        responses: { "201": { description: "作成成功" } }
      }
    },
    "/api/v1/projects/{id}/comment-threads": {
      get: {
        summary: "プロジェクトコメント履歴",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["open", "resolved", "all"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "cursor", in: "query", schema: { type: "string" } }
        ],
        responses: { "200": { description: "一覧取得成功" } }
      }
    },
    "/api/v1/projects/{id}/comments/{threadId}": {
      patch: {
        summary: "コメント更新",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "threadId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "更新成功" } }
      },
      delete: {
        summary: "コメント削除",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "threadId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "削除成功" } }
      }
    },
    "/api/v1/projects/{id}/comments/{threadId}/replies": {
      post: {
        summary: "コメント返信作成",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "threadId", in: "path", required: true, schema: { type: "string" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["body"],
                properties: {
                  body: { type: "string" },
                  actorKind: { type: "string", enum: ["human", "ai"], default: "human" }
                }
              }
            }
          }
        },
        responses: { "201": { description: "返信成功" } }
      }
    },
    "/api/v1/notifications": {
      get: {
        summary: "アプリ内通知一覧",
        parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["unread", "all"] } }],
        responses: { "200": { description: "一覧取得成功" } }
      }
    },
    "/api/v1/notifications/{id}/read": {
      post: {
        summary: "通知を既読にする",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "既読化成功" } }
      }
    },
    "/api/v1/notifications/read-all": {
      post: {
        summary: "すべての通知を既読にする",
        responses: { "200": { description: "既読化成功" } }
      }
    },
    "/api/v1/api-keys": {
      post: {
        summary: "API キー発行",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  scopes: { type: "array", default: ["read"], items: { type: "string", enum: ["read", "write", "deploy"] } },
                  project_id: { type: "string", description: "write/deployでは必須。readで省略するとアカウント情報と利用者に閲覧権限があるプロジェクトを読み取れる" },
                  expires_at: { type: "string", format: "date-time", description: "UTCのISO日時。既定30日、最長90日" }
                }
              }
            }
          }
        },
        responses: { "201": { description: "発行成功。raw_key は 1 回のみ返却される" } }
      },
      get: {
        summary: "API キー一覧",
        responses: { "200": { description: "一覧取得成功" } }
      }
    },
    "/api/v1/api-keys/{id}": {
      delete: {
        summary: "API キー削除",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "削除成功" } }
      }
    },
    "/api/v1/whoami": {
      get: { summary: "認証中の利用者", responses: { "200": { description: "利用者情報" } } }
    },
    "/api/v1/projects/{id}/upload-keys": {
      get: { summary: "プロジェクト所有者がアップロードキーのメタデータを取得", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "keys配列。原文とハッシュは含めない" }, "403": { description: "所有者のログインセッションが必要" } } },
      post: {
        summary: "プロジェクト所有者がアップロード専用キーを発行",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["name", "expires_at"], properties: {
          name: { type: "string", minLength: 1, maxLength: 100 }, expires_at: { type: "string", format: "date-time", description: "未来のUTC日時。必須。自動延長なし" }
        } } } } },
        responses: { "201": { description: "keyにメタデータ、raw_keyに一度だけ返す原文" }, "400": { description: "入力不正、または保存先フォルダ未作成" },
          "403": { description: "所有者でない、またはGoogle保存先の権限が不足" }, "503": { description: "サービスアカウント設定が未完了" } }
      }
    },
    "/api/v1/projects/{id}/upload-keys/{keyId}": {
      delete: { summary: "プロジェクト所有者がアップロードキーを取り消す", parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "keyId", in: "path", required: true, schema: { type: "string" } }
      ], responses: { "200": { description: "取消済み。転送中の要求も公開確定時に拒否" }, "403": { description: "所有者のログインセッションが必要" }, "404": { description: "該当キーなし" } } }
    },
    "/api/v1/organization/security-events": {
      get: { summary: "監査記録の直近100件。CI実行元のヘッダーは申告値", responses: { "200": { description: "監査記録" } } }
    },
    "/api/v1/organization/users/{id}/revocation-impact": {
      get: { summary: "利用者無効化の影響を確認", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "影響するキー、自動公開、セッション、Google連携" } } }
    },
    "/api/v1/organization/users/{id}/disable": {
      post: { summary: "利用者と認証情報を無効化", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "無効化済み" } } }
    }
  }
} as const;

export function openapiSpec(c: Context<AppBindings>): Response {
  const paths = Object.fromEntries(Object.entries(SPEC.paths).map(([path, operations]) => [path,
    Object.fromEntries(Object.entries(operations).map(([method, operation]) => {
      const permission = apiKeyPermissions.find(item => item.method === method.toUpperCase() && item.path.test(path.replace(/\{[^}]+\}/g, "id")));
      const uploads = path === "/api/v1/projects/{id}/deploy" && method === "post";
      const security = permission ? [{ sessionAuth: [] }, { bearerAuth: [] }, ...(uploads ? [{ uploadKeyAuth: [] }] : [])] : [{ sessionAuth: [] }];
      const detail = "description" in operation ? operation.description + " " : "";
      const auth = uploads ? "人のAPIキーはdeploy scopeと利用者の編集権限、アップロード専用キーはプロジェクト・期限・取消状態を確認する。" :
        permission ? `APIキーは${permission.scope} scopeが必要。公開先と利用者の権限も確認する。` : "ログインしたセッションが必要。APIキーでは実行不可。";
      return [method, { ...operation, security, description: detail + auth }];
    }))
  ]));
  return c.json({ ...SPEC, paths });
}
