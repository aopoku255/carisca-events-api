# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# CARISCA API — one image, two entrypoints. The worker runs the same code with
# a different command, so there is no way for the two to drift apart.
#
# Debian slim rather than Alpine: argon2 is a native module, and building it
# against musl is a reliable source of hours lost to node-gyp. The extra image
# size buys a password hash that works.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Toolchain for argon2's native build, present only in this stage — none of it
# reaches the final image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# `npm ci` from the lockfile: the build is reproducible, and an image can never
# quietly pick up a version the tests never ran against.
RUN npm ci --omit=dev


# ---------------------------------------------------------------------------
# Migration runner. Its own target because sequelize-cli is a devDependency:
# the schema tool has no business being in the image that serves traffic, and
# the runtime image should not carry a compiler-adjacent toolchain it never
# uses. `docker compose` builds this with `target: migrate`.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS migrate

ENV NODE_ENV=production

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# --include=dev despite NODE_ENV=production, which npm would otherwise take as
# instruction to skip exactly the package this stage exists for.
RUN npm ci --include=dev

COPY src ./src
COPY scripts ./scripts

USER node

CMD ["npm", "run", "db:migrate"]


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=4000 \
    # Local storage lives on a volume; ./storage inside the image would be lost
    # on every redeploy.
    STORAGE_LOCAL_PATH=/data/storage

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY worker.js ./

# The `node` user ships with the image. Running as root would mean an upload
# path bug is a root-owned file on a shared volume.
RUN mkdir -p /data/storage && chown -R node:node /data /app

USER node

EXPOSE 4000

# Hits the real endpoint, which checks the database — a process that is up but
# cannot reach MySQL is not healthy, and compose should not send traffic to it.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
