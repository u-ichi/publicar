import { Hono } from "hono";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "../../db/notifications";
import type { AppBindings } from "../../env";
import { clampRequestLimit } from "../../lib/request";

export const notificationsRoute = new Hono<AppBindings>();

notificationsRoute.get("/", async (c) => {
  const limit = clampRequestLimit(c.req.query("limit") ?? undefined, 50);
  const status = c.req.query("status") === "all" ? "all" : "unread";
  const result = await listNotifications(c.env, c.get("user").id, {
    status,
    limit,
    cursor: c.req.query("cursor") ?? undefined
  });
  return c.json(result);
});

notificationsRoute.post("/read-all", async (c) => {
  await markAllNotificationsRead(c.env, c.get("user").id);
  return c.json({ ok: true });
});

notificationsRoute.post("/:id/read", async (c) => {
  const updated = await markNotificationRead(c.env, c.get("user").id, c.req.param("id"));
  if (!updated) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ ok: true });
});
