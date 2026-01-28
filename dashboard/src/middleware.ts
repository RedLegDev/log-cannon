import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/llms.txt',
  '/api/v1/(.*)',  // API v1 uses its own API key auth
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
  // Note: Don't strip Clerk's internal params (__clerk_db_jwt, __clerk_ticket, __clerk_status)
  // Clerk's SDK handles its own URL cleanup. Stripping them in middleware interferes with
  // Clerk's redirect flow and can cause infinite loops on deep link navigation.
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
