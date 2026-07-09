import type { Context } from "hono";
import type { AppBindings } from "../../env";

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
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "API キー (pub_... 形式)"
      }
    },
    schemas: {
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
          expiresAt: { type: ["string", "null"] }
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
  security: [{ bearerAuth: [] }],
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
        description: "path クエリパラメータで単一ファイル、name=*.zip で ZIP デプロイ",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "path", in: "query", schema: { type: "string" }, description: "単一ファイルのパス" },
          { name: "name", in: "query", schema: { type: "string" }, description: "ZIP ファイル名 (*.zip)" }
        ],
        requestBody: {
          required: true,
          content: {
            "text/html": { schema: { type: "string" } },
            "application/zip": { schema: { type: "string", format: "binary" } }
          }
        },
        responses: { "200": { description: "デプロイ成功" } }
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
                  scopes: { type: "array", items: { type: "string", enum: ["read", "write", "deploy"] } },
                  expires_at: { type: "string" }
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
    }
  }
} as const;

export function openapiSpec(c: Context<AppBindings>): Response {
  return c.json(SPEC);
}
