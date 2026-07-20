# ═══════════════════════════════════════════════════════════════════════════════
#  Dockerfile — Agent-Nuvira: Multi-agent AI coding CLI + Web Dashboard
# ═══════════════════════════════════════════════════════════════════════════════
#
#  Build & run:
#    docker compose up
#
#  Or manually:
#    docker build -t agent-nuvira .
#    docker run -p 3030:3030 -v buff-data:/root/.buff agent-nuvira
#
#  Multi-stage build:
#    1. cli-builder    — TypeScript compilation (npm run build)
#    2. dashboard-builder — Vite build for the React dashboard
#    3. runtime        — Minimal production image
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Stage 1: CLI TypeScript Builder ─────────────────────────────────────────
FROM node:22-alpine AS cli-builder

WORKDIR /app

# Copy dependency manifests first (for Docker layer caching)
COPY package.json package-lock.json ./
COPY tsconfig.json ./

# Install all dependencies (including devDependencies for TypeScript)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build TypeScript → dist/
RUN npm run build


# ─── Stage 2: Dashboard Vite Builder ─────────────────────────────────────────
FROM node:22-alpine AS dashboard-builder

WORKDIR /app

# Copy dashboard dependency manifest (no lockfile for the subproject — use install)
COPY src/web-dashboard/package.json ./src/web-dashboard/package.json

# Install dashboard dependencies (lockfile-free install)
RUN cd src/web-dashboard && npm install

# Copy dashboard source code (after deps for layer caching)
COPY src/web-dashboard/ ./src/web-dashboard/

# Build the React dashboard (Vite outputs to src/web-dashboard/public/)
RUN cd src/web-dashboard && npm run build


# ─── Stage 3: Runtime Image ──────────────────────────────────────────────────
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="Agent-Nuvira"
LABEL org.opencontainers.image.description="Multi-agent AI coding CLI — plan, write, review, test, and publish code"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/imdheerajKube/agent-nuvira"

# Install minimal runtime dependencies (for child processes like git)
RUN apk add --no-cache git

WORKDIR /app

# Copy built CLI from Stage 1
COPY --from=cli-builder /app/dist ./dist
COPY --from=cli-builder /app/node_modules ./node_modules
COPY --from=cli-builder /app/package.json ./

# Copy dashboard static files from Stage 2
COPY --from=dashboard-builder /app/src/web-dashboard/public ./src/web-dashboard/public

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Dashboard server default port
EXPOSE 3030

# Persist config, memory, cache, and history at /root/.buff
VOLUME ["/root/.buff"]

# Entrypoint handles initialization, then runs the CLI
ENTRYPOINT ["docker-entrypoint.sh"]

# Default: launch the web dashboard on port 3030
CMD ["dashboard"]
