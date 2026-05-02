import { NextRequest, NextResponse } from "next/server";
import { isEmailAllowed } from "@/lib/auth/allowlist";
import { consumeOtp } from "@/lib/auth/otp-store";
import { createSessionCookie } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  const { email, code } = (await request.json()) as {
    email?: string;
    code?: string;
  };

  if (!email || !code) {
    return NextResponse.json(
      { error: "Email and code are required" },
      { status: 400 },
    );
  }

  const rawEmail = email.trim().toLowerCase();
  const submittedCode = String(code).trim();

  if (!/^\d{6}$/.test(submittedCode)) {
    return NextResponse.json(
      { valid: false, error: "Code must be 6 digits." },
      { status: 400 },
    );
  }

  if (!isEmailAllowed(rawEmail)) {
    return NextResponse.json(
      { valid: false, error: "That email isn't authorized for Log Cannon." },
      { status: 403 },
    );
  }

  let matched = false;
  try {
    matched = consumeOtp(rawEmail, submittedCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("OTP store read failed:", message);
    return NextResponse.json(
      { error: "Server configuration error: auth store unavailable" },
      { status: 500 },
    );
  }

  if (!matched) {
    return NextResponse.json(
      { valid: false, error: "Invalid or expired code." },
      { status: 401 },
    );
  }

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Server configuration error: AUTH_SECRET missing" },
      { status: 500 },
    );
  }

  const setCookie = await createSessionCookie(rawEmail, secret);
  const response = NextResponse.json({ valid: true });
  response.headers.set("Set-Cookie", setCookie);
  return response;
}
