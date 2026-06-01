# Build stamp: read git metadata (provided as the "gitdir" build context) and
# emit version.json. Resilient to a missing/empty git context (local builds).
FROM alpine/git AS stamp
WORKDIR /src
COPY --from=gitdir . /src/.git
RUN set -e; \
    if git -C /src rev-parse HEAD >/dev/null 2>&1; then \
      commit=$(git -C /src rev-parse HEAD); \
      short=$(git -C /src rev-parse --short=7 HEAD); \
      cdate=$(git -C /src log -1 --format=%cI); \
      branch=$(git -C /src rev-parse --abbrev-ref HEAD); \
    else \
      commit=dev; short=dev; cdate=; branch=dev; \
    fi; \
    btime=$(date -u +%Y-%m-%dT%H:%M:%SZ); \
    if [ -n "$cdate" ]; then cdate_json="\"$cdate\""; else cdate_json=null; fi; \
    printf '{"commit":"%s","commitFull":"%s","commitDate":%s,"buildTime":"%s","branch":"%s"}\n' \
      "$short" "$commit" "$cdate_json" "$btime" "$branch" > /version.json; \
    cat /version.json

FROM node:24-alpine AS deps
WORKDIR /app

# Build deps for better-sqlite3 native module (falls back to source build if no musl prebuilt)
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install

FROM node:24-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Overwrite the committed "dev" fallback with the real build stamp before build,
# so it compiles into the server bundle (no runtime fs / path assumptions).
COPY --from=stamp /version.json ./src/generated/version.json

ENV NEXT_TELEMETRY_DISABLED 1

RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

RUN mkdir .next
RUN chown nextjs:nodejs .next

# Auth SQLite lives here; mounted as a volume in docker-compose.
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Native module — Next.js standalone tracing can miss the .node binary.
# Copy the full package to be sure it loads at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path

USER nextjs

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["node", "server.js"]
