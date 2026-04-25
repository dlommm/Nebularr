FROM node:22-slim AS frontend-build

WORKDIR /ui
COPY frontend/package.json frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json frontend/vite.config.ts frontend/eslint.config.js /ui/
COPY frontend/index.html /ui/index.html
COPY frontend/src /ui/src
RUN npm install && npm run build

FROM python:3.12-slim

ARG APP_VERSION=1.2.1
ARG GIT_SHA=release

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_VERSION=${APP_VERSION} \
    APP_GIT_SHA=${GIT_SHA}

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY . /app
COPY --from=frontend-build /src/arrsync/web/dist /app/src/arrsync/web/dist
RUN pip install --no-cache-dir -e .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=5 CMD curl -fsS http://localhost:8080/healthz || exit 1

CMD ["uvicorn", "arrsync.main:app", "--host", "0.0.0.0", "--port", "8080"]
