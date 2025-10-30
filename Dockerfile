FROM oven/bun

WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --production

# Copy source code
COPY . .

# Expose port
EXPOSE 3119

# Set environment
ENV NODE_ENV=production

# Start the server
CMD ["bun", "start"]
