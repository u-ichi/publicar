import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { getDriveMemberSync, isDriveMember } from "../../storage/drive-members";

export const driveMembersRoute = new Hono<AppBindings>();

// 共有ドライブのメンバー一覧の取り込み状態。組織の利用者が、自分が一覧に含まれるかと併せて確認できる
driveMembersRoute.get("/status", async (c) => {
  const user = c.get("user");
  if (user.kind !== "member") return c.json({ error: "forbidden" }, 403);
  const sync = await getDriveMemberSync(c.env);
  return c.json({
    rule: sync?.last_success_at ? "drive_members" : "all_members",
    sync,
    self_included: sync?.last_success_at ? await isDriveMember(c.env, user.email) : null
  });
});
