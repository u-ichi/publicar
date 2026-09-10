import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";
import { randomId } from "../lib/id";

export const securityAudit: MiddlewareHandler<AppBindings> = async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  const auditable = pathname.startsWith("/api/") || pathname.startsWith("/auth/cli");
  if (auditable || pathname.startsWith("/auth/")) c.header("Cache-Control", "no-store");
  await next();
  if (!auditable) return;
  const uploadKey = c.get("uploadKey");
  let reason = c.get("rejectionReason") ?? null;
  if (!reason && c.res.status >= 400 && c.res.headers.get("Content-Type")?.includes("application/json")) {
    const response = await c.res.clone().json<{ error?: unknown }>().catch(() => null);
    if (typeof response?.error === "string" && /^[a-z0-9_]{1,100}$/.test(response.error)) reason = response.error;
  }
  const boundedHeader = (name: string, pattern: RegExp) => {
    const value = c.req.header(name);
    return value && pattern.test(value) ? value : null;
  };
  await c.env.DB.prepare(`INSERT INTO security_events
    (id, actor_id, auth_method, api_key_id, automation_grant_id, project_id, method, route, status, repository, commit_sha, ci_run_id, drive_user_id, upload_key_id, service_account, rejection_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(randomId("se"), c.get("user")?.id ?? null, c.get("authMethod") ?? "anonymous", c.get("apiKeyId") ?? null,
      null, pathname.match(/^\/api\/v1\/projects\/([^/]+)/)?.[1] ?? uploadKey?.projectId ?? null,
      c.req.method, pathname.slice(0, 512), c.res.status,
      uploadKey ? boundedHeader("X-Publicar-Repository", /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/) : null,
      uploadKey ? boundedHeader("X-Publicar-Commit", /^[a-f0-9]{40}$/) : null,
      uploadKey ? boundedHeader("X-Publicar-Run-Id", /^[0-9]{1,30}$/) : null,
      null, c.get("auditedUploadKeyId") ?? uploadKey?.id ?? null, c.get("driveServiceAccount") ?? null, reason).run();
};
