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

# Build stamp: record the image build time into src/generated/version.json so
# the System page can show when this image was built. (Portainer's build context
# has no .git, so there's no commit to read — build time is all we stamp.)
RUN node -e "const fs=require('fs');const p='src/generated/version.json';const v=JSON.parse(fs.readFileSync(p));v.buildTime=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');process.stdout.write(fs.readFileSync(p,'utf8'));"

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
