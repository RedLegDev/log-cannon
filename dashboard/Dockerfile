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

# Build stamp: baked into src/generated/version.json before `next build` so it
# compiles into the server bundle. Values arrive as build args because the .git
# dir is not present under Portainer's compose build context. Build time is
# always captured; commit/date/branch default to "dev" when not supplied.
ARG GIT_COMMIT=dev
ARG GIT_COMMIT_DATE=
ARG GIT_BRANCH=dev
RUN set -e; \
    short=$(printf '%s' "$GIT_COMMIT" | cut -c1-7); \
    btime=$(date -u +%Y-%m-%dT%H:%M:%SZ); \
    if [ -n "$GIT_COMMIT_DATE" ]; then cdate_json="\"$GIT_COMMIT_DATE\""; else cdate_json=null; fi; \
    printf '{"commit":"%s","commitFull":"%s","commitDate":%s,"buildTime":"%s","branch":"%s"}\n' \
      "$short" "$GIT_COMMIT" "$cdate_json" "$btime" "$GIT_BRANCH" > src/generated/version.json; \
    cat src/generated/version.json

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
