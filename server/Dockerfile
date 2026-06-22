# ──────────────────────────────────────────────────────────────────
# Stage 1: Build — compile TypeScript to JavaScript
# WHY multi-stage? The TypeScript compiler and @types packages are not
# needed at runtime. A two-stage build keeps the production image lean
# (~200 MB vs ~500 MB) and reduces the attack surface.
# ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first to take advantage of Docker layer caching.
# If package.json hasn't changed, npm ci reuses the cached layer.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ──────────────────────────────────────────────────────────────────
# Stage 2: Production — only runtime deps + compiled output
# ──────────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Create a non-root user.
# WHY? Running as root inside a container means a container-escape bug
# gives an attacker root on the host. The node user already exists in
# node:alpine images.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package*.json ./
# --omit=dev skips devDependencies (ts-jest, typescript, etc.)
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Ensure the non-root user owns the working directory.
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3001

# Use "node" directly (not npm start) so SIGTERM reaches the process,
# not npm's shell wrapper — enabling the graceful shutdown handler.
CMD ["node", "dist/index.js"]
