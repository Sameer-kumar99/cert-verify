FROM node:20-slim

# Install system dependencies for PDF rendering + OCR
RUN apt-get update && apt-get install -y \
    poppler-utils \
    ghostscript \
    tesseract-ocr \
    tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install node dependencies
RUN npm install --ignore-scripts

# Copy source
COPY . .

# Expose port
EXPOSE 4000

# Start server
CMD ["node", "server.js"]