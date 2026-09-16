FROM node:24-bookworm AS build
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY . .
RUN npm run build
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
CMD ["node", "apps/server/dist/index.js"]
