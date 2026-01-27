import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/llms.txt',
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  // After auth check passes, clean up Clerk's internal params from URL
  const url = request.nextUrl;
  const clerkParams = ['__clerk_db_jwt', '__clerk_ticket', '__clerk_status'];
  let hasClerkParams = false;

  for (const param of clerkParams) {
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param);
      hasClerkParams = true;
    }
  }

  // Redirect to clean URL (only happens if user is authenticated)
  if (hasClerkParams) {
    return NextResponse.redirect(url);
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
