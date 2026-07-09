import type { Env } from "../env";

export type CachedFile = {
  body: ArrayBuffer;
  contentType: string;
  etag: string | null;
};

export async function getCachedFile(env: Env, key: string): Promise<CachedFile | null> {
  const object = await env.CACHE_BUCKET.get(key);
  if (!object) {
    return null;
  }
  return {
    body: await object.arrayBuffer(),
    contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
    etag: object.etag ?? null
  };
}

export async function putCachedFile(env: Env, key: string, body: ArrayBuffer, contentType: string): Promise<string | null> {
  const object = await env.CACHE_BUCKET.put(key, body, {
    httpMetadata: { contentType }
  });
  return object?.etag ?? null;
}

export async function deleteCachedFile(env: Env, key: string): Promise<void> {
  await env.CACHE_BUCKET.delete(key);
}

export async function deleteCachedPrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const list = await env.CACHE_BUCKET.list({ prefix, cursor });
    await Promise.all(list.objects.map((object) => env.CACHE_BUCKET.delete(object.key)));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
