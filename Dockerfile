# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

ARG CSMAP_SOURCE_REPO=https://github.com/eharris/csmap.git
ARG CSMAP_REF=d5d9a8e03a1fea6b6d5e00025a31c3105779254a

WORKDIR /app
ENV PROJ_DATA=/usr/share/proj
ENV PROJ_NETWORK=OFF

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    clang \
    git \
    make \
    pkg-config \
    libproj-dev \
    proj-bin \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN rm -rf vendor/csmap \
  && mkdir -p vendor \
  && git clone "$CSMAP_SOURCE_REPO" vendor/csmap \
  && git -C vendor/csmap checkout --detach "$CSMAP_REF"

RUN if git -C vendor/csmap apply --check --ignore-space-change /app/patches/csmap-macos-clang.patch >/dev/null 2>&1; then \
      git -C vendor/csmap apply --ignore-space-change /app/patches/csmap-macos-clang.patch; \
    elif git -C vendor/csmap apply --reverse --check --ignore-space-change /app/patches/csmap-macos-clang.patch >/dev/null 2>&1; then \
      echo "CS-MAP patch already applied"; \
    else \
      echo "CS-MAP patch does not apply cleanly" >&2; \
      exit 1; \
    fi

RUN make test \
  && test -x bin/live_compare \
  && test -f web/report.js \
  && test -f dist/server/server.js \
  && test -f vendor/csmap/CsMapDev/Dictionaries/coordsys.asc

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV PROJ_DATA=/usr/share/proj
ENV PROJ_NETWORK=OFF
ENV COMPARE_CONCURRENCY=2
ENV COMPARE_QUEUE_LIMIT=16

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    proj-bin \
    proj-data \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
COPY --from=build /app/bin/live_compare ./bin/live_compare
COPY --from=build /app/vendor/csmap/CsMapDev/Dictionaries ./vendor/csmap/CsMapDev/Dictionaries

EXPOSE 4173
CMD ["npm", "start"]
