FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY --from=build /app/build ./build
COPY worker ./worker
COPY scripts ./scripts
COPY tests/fixtures ./tests/fixtures
RUN mkdir -p /app/uploads
EXPOSE 3000
CMD ["node", "build"]
