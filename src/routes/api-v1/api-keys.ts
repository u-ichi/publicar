import { Hono } from "hono";
import { createApiKey, deleteApiKey, expirationTime, listApiKeys, validateScopes, type Scope } from "../../db/api-keys";
import type { AppBindings } from "../../env";
import { readJsonObject } from "../../lib/request";
import { canEditProject, getProjectRole } from "../../db/projects";

export const apiKeysRoute = new Hono<AppBindings>();

apiKeysRoute.post("/", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ error: "invalid_json" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) {
    return c.json({ error: "name is required" }, 400);
  }

  let scopes: Scope[] | undefined;
  if (body.scopes !== undefined) {
    const validated = validateScopes(body.scopes);
    if (!validated) {
      return c.json({ error: "invalid scopes" }, 400);
    }
    scopes = validated;
  }

  const expiresAt = body.expires_at === undefined || body.expires_at === null ? null : body.expires_at;
  if (expiresAt !== null && (typeof expiresAt !== "string" || !(expirationTime(expiresAt) > Date.now()))) {
    return c.json({ error: "invalid expires_at" }, 400);
  }
  if (expiresAt && Date.parse(expiresAt) > Date.now() + 90 * 86400000) return c.json({ error: "expiry_exceeds_90_days" }, 400);
  const projectId = body.project_id;
  if (projectId !== undefined && (typeof projectId !== "string" || !projectId)) return c.json({ error: "invalid_project_id" }, 400);
  if (projectId) {
    const role = await getProjectRole(c.env, projectId, c.get("user").id);
    if (!role || ((scopes ?? ["read"]).some((scope) => scope !== "read") && !canEditProject(role))) {
      return c.json({ error: "forbidden" }, 403);
    }
  } else if ((scopes ?? ["read"]).some((scope) => scope !== "read")) {
    return c.json({ error: "project_id_required" }, 400);
  }

  const { apiKey, rawKey } = await createApiKey(c.env, c.get("user").id, {
    name,
    scopes,
    expiresAt,
    projectId: typeof projectId === "string" ? projectId : null
  });
  return c.json({ ok: true, api_key: apiKey, raw_key: rawKey }, 201);
});

apiKeysRoute.get("/", async (c) => {
  return c.json({ api_keys: await listApiKeys(c.env, c.get("user").id) });
});

apiKeysRoute.delete("/:id", async (c) => {
  const deleted = await deleteApiKey(c.env, c.req.param("id"), c.get("user").id);
  if (!deleted) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ ok: true });
});
