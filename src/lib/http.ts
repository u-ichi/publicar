export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function projectUrl(request: Request, alias: string): string {
  return new URL(`/${alias}/`, request.url).toString();
}

export function emailDomain(email: string): string | null {
  const parts = email.toLowerCase().split("@");
  return parts.length === 2 && parts[1] ? parts[1] : null;
}

export function jsonArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return null;
  }
  return value;
}
