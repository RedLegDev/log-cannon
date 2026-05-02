function loadAllowedEmails(): Set<string> {
  const raw = process.env.AUTH_ALLOWED_EMAILS || "";
  const emails = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return new Set(emails);
}

export function isEmailAllowed(email: string): boolean {
  return loadAllowedEmails().has(email.trim().toLowerCase());
}
