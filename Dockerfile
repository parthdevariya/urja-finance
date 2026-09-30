FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
# copy every server module (server.js, bc.js, …) so new modules are never left out
COPY *.js ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
EXPOSE 3000
USER node
CMD ["node", "server.js"]
