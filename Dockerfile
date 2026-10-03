FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY lib lib
COPY public public
COPY server.js ./
ENV NODE_ENV=production HOST=127.0.0.1 PORT=3000 DB_FILE=/app/data/straighttalk.db
VOLUME /app/data
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
