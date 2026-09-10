import { afterEach, describe, expect, it, vi } from "vitest";
import { serviceAccountToken } from "../auth/service-account";
import { base64UrlJson, base64UrlToBytes, utf8ToBytes } from "../lib/encoding";
import { serviceEnv, servicePublicKey, SERVICE_EMAIL } from "./service-account-helpers";

describe("Google service account authentication", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs a valid assertion without impersonation and keeps Google credentials on the server", async () => {
    const env = await serviceEnv();
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/token");
      expect(init?.redirect).toBe("manual");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      const assertion = body.get("assertion")!;
      const [header, claims, signature] = assertion.split(".");
      expect(base64UrlJson(header)).toEqual({ alg: "RS256", typ: "JWT" });
      expect(base64UrlJson<Record<string, unknown>>(claims)).toMatchObject({ iss: SERVICE_EMAIL,
        scope: "https://www.googleapis.com/auth/drive", aud: "https://oauth2.googleapis.com/token" });
      expect(base64UrlJson<Record<string, unknown>>(claims)).not.toHaveProperty("sub");
      expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", await servicePublicKey(), base64UrlToBytes(signature), utf8ToBytes(`${header}.${claims}`))).toBe(true);
      expect(String(init?.body)).not.toContain("PRIVATE KEY");
      return Response.json({ access_token: "test-service-access", expires_in: 3600, token_type: "Bearer" });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await serviceAccountToken(env)).toBe("test-service-access");
    expect(await serviceAccountToken(env)).toBe("test-service-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await serviceAccountToken(env, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry Google authentication using a personal OAuth endpoint", async () => {
    const env = await serviceEnv();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response("denied", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(serviceAccountToken(env)).rejects.toThrow("service_account_token_failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
  });
});
