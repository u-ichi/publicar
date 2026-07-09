import type { Context } from "hono";
import type { AppBindings } from "../env";

export async function runBackground(c: Pick<Context<AppBindings>, "executionCtx">, promise: Promise<void>): Promise<void> {
  try {
    c.executionCtx.waitUntil(promise);
  } catch (error) {
    if (error instanceof Error && error.message.includes("ExecutionContext")) {
      await promise;
      return;
    }
    throw error;
  }
}
