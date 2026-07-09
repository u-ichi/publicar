import type { Context } from "hono";
import { canOwnProject, getProjectRole, type ProjectRole } from "../../db/projects";
import type { AppBindings } from "../../env";

export function roleErrorResponse(c: Context<AppBindings>, role: ProjectRole | null): Response {
  return c.json({ error: role ? "forbidden" : "not_found" }, role ? 403 : 404);
}

export async function requireOwner(c: Context<AppBindings>, projectId: string): Promise<Response | null> {
  const role = await getProjectRole(c.env, projectId, c.get("user").id);
  if (!canOwnProject(role)) {
    return roleErrorResponse(c, role);
  }
  return null;
}
