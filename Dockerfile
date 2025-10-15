# Use Node.js 18 LTS as base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy server package files
COPY server-package.json package.json

# Install production dependencies only
RUN npm ci --only=production

# Copy the proxy server code
COPY proxy-server.js ./

# Expose port (Code Engine will set PORT env var)
EXPOSE 8080

# Set environment variable for port
ENV PORT=8080

# Start the server
CMD ["node", "proxy-server.js"]

