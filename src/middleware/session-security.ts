import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";

// URLでは対象を絞らない。未復号のURLで絞ると、符号化したパスで確認を迂回されるため。
export const rejectCrossOriginMutation: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
  const origin = c.req.header("Origin");
  const site = c.req.header("Sec-Fetch-Site");
  if ((origin && origin !== new URL(c.req.url).origin) || site === "cross-site" || site === "same-site") {
    return c.json({ error: "cross_origin_request_denied" }, 403);
  }
  return next();
};
