import { Hono, type MiddlewareHandler } from "hono";
import type { AppBindings } from "../../env";
import { serviceAccountConfigured } from "../../auth/service-account";
import { expirationTime } from "../../db/api-keys";
import { getProjectRole } from "../../db/projects";
import { createUploadKey, uploadKeyColumns, type UploadKey } from "../../db/upload-keys";
import { readJsonObject } from "../../lib/request";
import { enableServiceAccountStorage } from "../../storage/service-account-drive";
import { driveFailureResponse } from "./drive-errors";

export const uploadKeysRoute = new Hono<AppBindings>();
const requireOwner: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("authMethod") !== "session") return c.json({ error: "session_required" }, 403);
  if (await getProjectRole(c.env, c.req.param("id")!, c.get("user").id) !== "owner") {
    return c.json({ error: "project_owner_required" }, 403);
  }
  c.header("Cache-Control", "no-store");
  return next();
};
uploadKeysRoute.use("/:id/upload-keys", requireOwner);
uploadKeysRoute.use("/:id/upload-keys/:keyId", requireOwner);

uploadKeysRoute.get("/:id/upload-keys", async (c) => {
  const result = await c.env.DB.prepare(`SELECT ${uploadKeyColumns} FROM upload_keys WHERE project_id = ? ORDER BY created_at DESC`)
    .bind(c.req.param("id")).all<UploadKey>();
  return c.json({ keys: result.results });
});

uploadKeysRoute.post("/:id/upload-keys", async (c) => {
  if (!serviceAccountConfigured(c.env)) return c.json({ error: "service_account_not_configured" }, 503);
  const body = await readJsonObject(c.req.raw);
  if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > 100 ||
      typeof body.expires_at !== "string" || !(expirationTime(body.expires_at) > Date.now()) ||
      Object.keys(body).some((key) => key !== "name" && key !== "expires_at")) {
    return c.json({ error: "invalid_upload_key" }, 400);
  }
  try {
    await enableServiceAccountStorage(c.env, c.req.param("id"), c.get("user").id);
    c.set("driveServiceAccount", c.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!);
    const issued = await createUploadKey(c.env, { projectId: c.req.param("id"), name: body.name.trim(), createdBy: c.get("user").id,
      expiresAt: new Date(body.expires_at).toISOString() });
    c.set("auditedUploadKeyId", issued.key.id);
    return c.json(issued, 201);
  } catch (error) {
    const response = driveFailureResponse(c, error);
    if (response) return response;
    let diagnostic = "unknown_error";
    if (error instanceof Error) diagnostic = error.name === "SyntaxError" ? error.name : error.message;
    console.error("upload_key_internal_error", diagnostic);
    return c.json({ error: "upload_key_create_failed" }, 502);
  }
});

uploadKeysRoute.delete("/:id/upload-keys/:keyId", async (c) => {
  const result = await c.env.DB.prepare("UPDATE upload_keys SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ? AND project_id = ?")
    .bind(c.req.param("keyId"), c.req.param("id")).run();
  if (result.meta.changes) c.set("auditedUploadKeyId", c.req.param("keyId"));
  return result.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});
