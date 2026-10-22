# Le serveur de Mell en conteneur, pour Aiven Runtime. La base vient de DATABASE_URL (Aiven PostgreSQL).
FROM node:22-slim
WORKDIR /app
RUN npm install -g pnpm@11.17.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY relay/package.json relay/
COPY sim/package.json sim/
RUN pnpm install --frozen-lockfile
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "server/src/main.ts"]
