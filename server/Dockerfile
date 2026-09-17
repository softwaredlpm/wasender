# ==============================================================================
# WASENDER Cloud VPS API & WebSocket Hub - Production Dockerfile
# Optimized multi-layer build using Node.js 20 Alpine
# ==============================================================================

FROM node:20-alpine AS base

# Install curl/wget for health check
RUN apk add --no-cache curl wget

WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=5001

# Copy dependency manifests
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source code and frontend public assets
COPY src/ ./src/
COPY public/ ./public/

# Prepare directories for uploads and logs with proper permissions
RUN mkdir -p uploads logs && chown -R node:node /app

# Run container as non-root user for security
USER node

# Expose API & WebSocket port
EXPOSE 5001

# Container Health Check (verifies API responsiveness every 30s)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:5001/health || exit 1

# Start the Cloud VPS Server
CMD ["node", "src/index.js"]
