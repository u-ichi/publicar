import { Hono } from "hono";
import { createSession, clearSessionCookie, destroySession, getActiveSessionUser } from "./auth/session";
import { createLoginUrl, handleOAuthCallback, oauthBrowserCookie } from "./auth/oauth";
import { randomBase64Url } from "./lib/encoding";
import { deleteOldAccessLogs } from "./db/access-logs";
import type { AppBindings, Env } from "./env";
import { requireAuth, requireGuestAllowlist, requireScope, resolveAuth } from "./middleware/auth";
import { enforceApiKeyPermissions } from "./middleware/api-permissions";
import { rejectCrossOriginMutation, requireRecentSession } from "./middleware/session-security";
import { securityAudit } from "./middleware/security-audit";
import { apiKeysRoute } from "./routes/api-v1/api-keys";
import { commentsRoute } from "./routes/api-v1/comments";
import { deployProject } from "./routes/api-v1/deploy";
import { notificationsRoute } from "./routes/api-v1/notifications";
import { openapiSpec } from "./routes/api-v1/openapi";
import { assetsRoute } from "./routes/assets";
import { cliAuthRoute } from "./routes/auth-cli";
import { home, projectDetail, projectReview } from "./routes/home";
import { projectsRoute } from "./routes/api-v1/projects";
import { organizationRoute } from "./routes/api-v1/organization";
import { uploadKeysRoute } from "./routes/api-v1/upload-keys";
import { serveProject } from "./routes/serve";
import { cleanupUploads } from "./storage/upload-cleanup";
import { llmsTxt } from "./routes/wellknown";

const app = new Hono<AppBindings>();
app.use("*", securityAudit);
app.use("*", rejectCrossOriginMutation);

app.get("/health", (c) => {
  return c.json({
    ok: true,
    devMode: c.env.DEV_MODE === "true"
  });
});

app.route("/", assetsRoute);

app.get("/auth/login", async (c) => {
  const binding = randomBase64Url(32);
  const response = c.redirect(await createLoginUrl(c.req.raw, c.env, binding), 302);
  response.headers.append("Set-Cookie", oauthBrowserCookie(c.req.raw, binding));
  return response;
});

app.get("/auth/callback", async (c) => {
  try {
    const { user, redirectTo } = await handleOAuthCallback(c.req.raw, c.env);
    const response = c.redirect(redirectTo, 302);
    response.headers.append("Set-Cookie", await createSession(c.env, user));
    response.headers.append("Set-Cookie", oauthBrowserCookie(c.req.raw, ""));
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth callback failed";
    if (message.includes("domain is not allowed")) {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json({ error: "invalid_oauth_callback" }, 400);
  }
});

app.get("/auth/logout", async (c) => {
  const site = c.req.header("Sec-Fetch-Site");
  const origin = c.req.header("Origin");
  if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== new URL(c.req.url).origin)) {
    return c.json({ error: "cross_origin_request_denied" }, 403);
  }
  await destroySession(c.req.raw, c.env);
  const response = c.redirect("/", 302);
  response.headers.append("Set-Cookie", clearSessionCookie(c.env));
  return response;
});

app.get("/auth/me", async (c) => {
  const user = await getActiveSessionUser(c.req.raw, c.env);
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json({ user });
});

app.route("/auth", cliAuthRoute);
app.get("/llms.txt", llmsTxt);
app.get("/api/v1/openapi.json", openapiSpec);

app.use("*", resolveAuth);
app.use("*", enforceApiKeyPermissions);
app.use("/api/*", requireAuth);
app.use("/api/*", requireGuestAllowlist);
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const managesKeys = /^\/api\/v1\/api-keys(?:\/|$)/.test(path);
  const managesProject = c.req.method !== "GET" && /^\/api\/v1\/projects(?:\/[^/]+(?:\/(?:members|access)(?:\/[^/]+)?)?)?\/?$/.test(path);
  if (managesKeys || managesProject) return requireRecentSession(c, next);
  return next();
});

app.get("/api/v1/whoami", (c) => {
  return c.json({ user: c.get("user") });
});
// commentsRoute must stay before projectsRoute so project subresources
// (/:id/comments, /:id/comment-threads, /:id/review-content) are not
// consumed by projectsRoute's /:id handlers.
app.route("/api/v1/projects", commentsRoute);
app.route("/api/v1/projects", uploadKeysRoute);
app.route("/api/v1/projects", projectsRoute);
app.route("/api/v1/api-keys", apiKeysRoute);
app.route("/api/v1/notifications", notificationsRoute);
app.route("/api/v1/organization", organizationRoute);
app.post("/api/v1/projects/:id/deploy", requireScope("deploy"), deployProject);
app.get("/p/:alias", serveProject);
app.get("/p/:alias/", serveProject);
app.get("/p/:alias/:path{.*}", serveProject);

app.get("/", home);
app.get("/projects/:id", projectDetail);
app.get("/projects/:id/review", projectReview);
app.get("/:alias", serveProject);
app.get("/:alias/", serveProject);
app.get("/:alias/:path{.*}", serveProject);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if ((event.cron === "* * * * *" || event.cron === "15 * * * *")) {
      ctx.waitUntil(cleanupUploads(env));
      return;
    }
    const days = parseInt(env.ACCESS_LOG_RETENTION_DAYS ?? "90", 10);
    if (days > 0) {
      ctx.waitUntil(deleteOldAccessLogs(env, days));
    }
    const securityDays = Number(env.SECURITY_LOG_RETENTION_DAYS ?? "90");
    if (Number.isInteger(securityDays) && securityDays > 0) {
      ctx.waitUntil(env.DB.prepare("DELETE FROM security_events WHERE created_at < datetime('now', ?)").bind(`-${securityDays} days`).run());
    }
  }
};
