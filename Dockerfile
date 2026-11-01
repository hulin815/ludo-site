FROM node:20-alpine

WORKDIR /app
COPY standalone/ /app/
COPY ludo-chess/ /ludo-chess/

ENV PORT=8787
EXPOSE 8787

# 用平台给的端口（Render 会注入 PORT）
CMD node server.mjs --port ${PORT:-8787}