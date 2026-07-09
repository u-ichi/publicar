import { Hono } from "hono";
import { createApiKey, deleteApiKey, listApiKeys, validateScopes, type Scope } from "../../db/api-keys";
import type { AppBindings } from "../../env";
import { readJsonObject } from "../../lib/request";

export const apiKeysRoute = new Hono<AppBindings>();

apiKeysRoute.post("/", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ error: "invalid_json" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
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
  if (expiresAt !== null && typeof expiresAt !== "string") {
    return c.json({ error: "invalid expires_at" }, 400);
  }

  const { apiKey, rawKey } = await createApiKey(c.env, c.get("user").id, {
    name,
    scopes,
    expiresAt
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
