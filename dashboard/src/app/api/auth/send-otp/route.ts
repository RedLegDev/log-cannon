import { NextRequest, NextResponse } from "next/server";
import { isEmailAllowed } from "@/lib/auth/allowlist";
import { putOtp } from "@/lib/auth/otp-store";
import { sendOtpEmail } from "@/lib/email/send-otp-email";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { email?: string };
  const rawEmail = body.email?.trim().toLowerCase();

  if (!rawEmail) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  if (!isEmailAllowed(rawEmail)) {
    return NextResponse.json(
      { error: "That email isn't authorized for Log Cannon." },
      { status: 403 },
    );
  }

  const expiryMinutes = process.env.OTP_EXPIRY_MINUTES || "10";
  const ttlSeconds = parseInt(expiryMinutes, 10) * 60;

  const code = String(Math.floor(100000 + Math.random() * 900000));

  try {
    putOtp(rawEmail, code, ttlSeconds);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("OTP store write failed:", message);
    return NextResponse.json(
      { error: "Server configuration error: auth store unavailable" },
      { status: 500 },
    );
  }

  const result = await sendOtpEmail(rawEmail, code, expiryMinutes);
  if (!result.ok) {
    return NextResponse.json(
      { error: "Failed to send email", detail: result.error },
      { status: 502 },
    );
  }

  return NextResponse.json({ success: true });
}
