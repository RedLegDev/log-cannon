import { NextResponse, type NextRequest } from "next/server";
import { parseSessionCookie, SESSION_COOKIE_NAME } from "@/lib/auth/session";

const PUBLIC_PREFIXES = [
  "/api/v1/",
  "/api/mcp",
  "/api/alerts",
];

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/send-otp",
  "/api/auth/verify-otp",
  "/api/auth/logout",
  "/llms.txt",
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/llms.txt/")) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Server misconfigured: AUTH_SECRET missing" },
        { status: 500 },
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  const sessionValue = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const cookieHeader = sessionValue
    ? `${SESSION_COOKIE_NAME}=${sessionValue}`
    : null;
  const email = await parseSessionCookie(cookieHeader, secret);

  if (!email) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next|llms\\.txt|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
