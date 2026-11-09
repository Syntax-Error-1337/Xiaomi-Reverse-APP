FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
ENV PORT=4000
VOLUME /app/data
EXPOSE 4000
CMD ["sh", "-c", "node src/seed.js && node src/server.js"]
