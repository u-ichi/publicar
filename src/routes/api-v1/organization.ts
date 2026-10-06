import { Hono } from "hono";
import { getUserById } from "../../db/users";
import type { AppBindings } from "../../env";
import { requireRecentSession } from "../../middleware/session-security";

export const organizationRoute = new Hono<AppBindings>();
organizationRoute.use("*", requireRecentSession);
organizationRoute.use("*", async (c, next) => {
  const admins = (c.env.ORGANIZATION_ADMIN_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (!c.env.AUTOMATION_ORGANIZATION_ID || !admins.includes(c.get("user").email.toLowerCase())) {
    return c.json({ error: "organization_admin_required" }, 403);
  }
  return next();
});

organizationRoute.get("/security-events", async (c) => {
  const events = await c.env.DB.prepare("SELECT * FROM security_events ORDER BY created_at DESC LIMIT 100").all();
  return c.json({ events: events.results });
});

organizationRoute.get("/users/:id/revocation-impact", async (c) => {
  const userId = c.req.param("id");
  const person = await getUserById(c.env, userId);
  if (!person) return c.json({ error: "not_found" }, 404);
  const keys = await c.env.DB.prepare("SELECT id, name, project_id, expires_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").bind(userId).all();
  return c.json({ user: person, api_keys: keys.results, sessions: "all", google_connection: "revoked_locally" });
});

organizationRoute.post("/users/:id/disable", async (c) => {
  const userId = c.req.param("id");
  if (!(await getUserById(c.env, userId))) return c.json({ error: "not_found" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET disabled_at = datetime('now'), sessions_valid_after = ?, encrypted_access_token = NULL, encrypted_refresh_token = NULL, token_expires_at = NULL WHERE id = ?").bind(Date.now(), userId),
    c.env.DB.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE user_id = ?").bind(userId)
  ]);
  return c.json({ ok: true });
});
