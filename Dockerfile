FROM node:22-bookworm-slim

WORKDIR /app

# Install Node dependencies (skip playwright browser download — not needed for SMS/scheduler MVP)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy application code
COPY . .

EXPOSE 3000
CMD ["node", "multi-user-scheduler.js"]
