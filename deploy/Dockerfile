# Production Multi-Stage Dockerfile for SentinelGW
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Copy Lua scripts and configuration
COPY src/limiter/scripts/ ./dist/limiter/scripts/

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled artifacts from builder
COPY --from=builder /app/dist ./dist
COPY config/ ./config/

EXPOSE 8080

CMD ["node", "dist/index.js"]
