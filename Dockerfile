# Builder stage
FROM node:16 AS builder

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies (including dev dependencies for building)
RUN npm ci --verbose

# Copy the rest of the application code
COPY . .

# Final stage
FROM node:16-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy only production dependencies from the builder stage
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Copy the rest of the application code
COPY --from=builder /usr/src/app .

# Expose the port the app runs on
EXPOSE 3001

# Start the application
# Trigger new build with comment
CMD ["npm", "start"]