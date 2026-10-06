import { Hono } from "hono";
import { API_KEY_MAX_DAYS, createApiKey, deleteApiKey, expirationTime, listApiKeys } from "../../db/api-keys";
import type { AppBindings } from "../../env";
import { readJsonObject } from "../../lib/request";

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

  // キーは本人として扱うため、権限やプロジェクトでの絞り込みは受け付けない
  if (body.scopes !== undefined || body.project_id !== undefined) {
    return c.json({ error: "api_key_restrictions_unsupported" }, 400);
  }

  const expiresAt = body.expires_at === undefined || body.expires_at === null ? null : body.expires_at;
  if (expiresAt !== null && (typeof expiresAt !== "string" || !(expirationTime(expiresAt) > Date.now()))) {
    return c.json({ error: "invalid expires_at" }, 400);
  }
  if (expiresAt && Date.parse(expiresAt) > Date.now() + API_KEY_MAX_DAYS * 86400000) return c.json({ error: "expiry_exceeds_365_days" }, 400);

  const { apiKey, rawKey } = await createApiKey(c.env, c.get("user").id, { name, expiresAt });
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
