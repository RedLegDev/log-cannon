import nodemailer from "nodemailer";

function buildOtpEmailHtml(code: string, expiryMinutes: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Log Cannon verification code</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0b;padding:40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background-color:#141416;border-radius:16px;overflow:hidden;max-width:560px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
          <tr>
            <td align="center" style="padding:36px 40px 12px;">
              <h1 style="margin:0;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:1px;">LOG <span style="color:#FF4D2A;">CANNON</span></h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 40px 24px;">
              <p style="margin:0;font-size:14px;line-height:20px;color:#9ca3af;">Your sign-in code</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 40px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="background-color:#1f1f23;border:1px solid rgba(255,77,42,0.3);border-radius:12px;width:auto;">
                <tr>
                  <td align="center" style="padding:20px 36px;">
                    <span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:34px;font-weight:600;letter-spacing:10px;color:#FF4D2A;">${code}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:20px 40px 8px;">
              <p style="margin:0;font-size:14px;line-height:22px;color:#9ca3af;">Enter this code to sign in. It expires in ${expiryMinutes} minutes.</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 40px 32px;">
              <p style="margin:0;font-size:12px;line-height:18px;color:#6b7280;">If you didn't request this code, you can safely ignore this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export interface SendOtpResult {
  ok: boolean;
  error?: string;
}

export async function sendOtpEmail(
  toEmail: string,
  code: string,
  expiryMinutes: string,
): Promise<SendOtpResult> {
  const transport = (process.env.EMAIL_TRANSPORT || "smtp").toLowerCase();
  const fromEmail =
    process.env.EMAIL_FROM || "Log Cannon <logs@example.com>";
  const subject = "Your Log Cannon sign-in code";
  const html = buildOtpEmailHtml(code, expiryMinutes);
  const text = `Your Log Cannon sign-in code is ${code}. It expires in ${expiryMinutes} minutes. If you didn't request this, you can ignore this email.`;

  if (transport === "smtp") {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || "2500", 10);
    if (!host) {
      return { ok: false, error: "SMTP_HOST not configured" };
    }
    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: false,
        ignoreTLS: true,
      });
      await transporter.sendMail({
        from: fromEmail,
        to: toEmail,
        subject,
        text,
        html,
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("SMTP send failed:", message);
      return { ok: false, error: message };
    }
  }

  if (transport === "saasmail") {
    const apiKey = process.env.SAASMAIL_API_KEY;
    if (!apiKey) {
      return { ok: false, error: "SAASMAIL_API_KEY not configured" };
    }
    const mailApiUrl = process.env.SAASMAIL_API_URL;
    if (!mailApiUrl) {
      return { ok: false, error: "SAASMAIL_API_URL not configured" };
    }
    try {
      const form = new FormData();
      form.append(
        "payload",
        JSON.stringify({
          to: toEmail,
          fromAddress: fromEmail,
          subject,
          bodyHtml: html,
          bodyText: text,
        }),
      );
      const res = await fetch(`${mailApiUrl}/api/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) {
        const errBody = await res.text();
        console.error("SaaSMail send failed:", res.status, errBody);
        return { ok: false, error: errBody };
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("SaaSMail send exception:", message);
      return { ok: false, error: message };
    }
  }

  return { ok: false, error: `Unknown EMAIL_TRANSPORT: ${transport}` };
}
