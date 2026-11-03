# k8s_manager와 동일 컨벤션(ADR-039): 베이스 이미지 버전 고정, 의존성/코드 레이어 분리.
FROM node:22.16.0-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

USER node

EXPOSE 8100

CMD ["node", "main.cjs"]
