const SESSION_COOKIE_NAME = "lc_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

async function getKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await getKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verify(
  payload: string,
  signatureHex: string,
  secret: string,
): Promise<boolean> {
  const key = await getKey(secret);
  const match = signatureHex.match(/.{2}/g);
  if (!match) return false;
  const sigBytes = new Uint8Array(match.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(payload),
  );
}

export async function createSessionCookie(
  email: string,
  secret: string,
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${email}|${timestamp}`;
  const sig = await sign(payload, secret);
  const value = `${payload}|${sig}`;
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export async function parseSessionCookie(
  cookieHeader: string | null,
  secret: string,
): Promise<string | null> {
  if (!cookieHeader) return null;

  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!match) return null;

  const value = decodeURIComponent(match.split("=").slice(1).join("="));
  const parts = value.split("|");
  if (parts.length !== 3) return null;

  const [email, timestampStr, sig] = parts;
  const payload = `${email}|${timestampStr}`;

  const valid = await verify(payload, sig, secret);
  if (!valid) return null;

  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > SESSION_MAX_AGE_SECONDS) return null;

  return email;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export { SESSION_COOKIE_NAME };
