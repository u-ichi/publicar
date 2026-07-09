import { base64UrlJson, base64UrlToBytes, bytesToUtf8, utf8ToBytes } from "../lib/encoding";

type Jwk = JsonWebKey & {
  kid?: string;
  alg?: string;
};

type Jwks = {
  keys: Jwk[];
};

type JwtHeader = {
  alg: string;
  kid?: string;
};

export type JwtVerifyOptions = {
  audience: string;
  issuer: string[];
  nonce: string;
};

export function createRemoteJWKSet(url: string): () => Promise<Jwks> {
  let cached: Jwks | null = null;
  return async () => {
    if (cached) {
      return cached;
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Unable to fetch JWKS");
    }
    cached = await response.json<Jwks>();
    return cached;
  };
}

function signingInput(parts: string[]): Uint8Array {
  return utf8ToBytes(`${parts[0]}.${parts[1]}`);
}

async function verifySignature(header: JwtHeader, parts: string[], jwks: Jwks): Promise<void> {
  if (header.alg !== "RS256") {
    throw new Error("Unsupported JWT algorithm");
  }
  const jwk = jwks.keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) {
    throw new Error("JWT signing key not found");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(parts[2]),
    signingInput(parts)
  );
  if (!verified) {
    throw new Error("JWT signature verification failed");
  }
}

export async function jwtVerify<T extends { iss: string; aud: string; exp: number; nonce?: string }>(
  token: string,
  jwks: () => Promise<Jwks>,
  options: JwtVerifyOptions
): Promise<T> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }
  const header = base64UrlJson<JwtHeader>(parts[0]);
  await verifySignature(header, parts, await jwks());
  const claims = JSON.parse(bytesToUtf8(base64UrlToBytes(parts[1]))) as T;
  if (!options.issuer.includes(claims.iss)) {
    throw new Error("Invalid JWT issuer");
  }
  if (claims.aud !== options.audience) {
    throw new Error("Invalid JWT audience");
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("JWT is expired");
  }
  if (claims.nonce !== options.nonce) {
    throw new Error("Invalid JWT nonce");
  }
  return claims;
}
