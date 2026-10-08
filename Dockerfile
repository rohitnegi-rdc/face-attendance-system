FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
# URL prefix baked into the build, e.g. /pump-attendance. Empty serves from the domain root.
ARG BASE_PATH=""
ENV BASE_PATH=${BASE_PATH}
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
