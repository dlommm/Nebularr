FROM python:3.13-slim

ARG APP_VERSION=1.2.3
ARG GIT_SHA=release

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_VERSION=${APP_VERSION} \
    APP_GIT_SHA=${GIT_SHA}

WORKDIR /app

# Upgrade base packages only (no curl: it pulls libnghttp2, which was flagged as HIGH by Docker Scout on Debian 13)
RUN apt-get update \
    && apt-get upgrade -y -o Dpkg::Options::="--force-confold" \
    && rm -rf /var/lib/apt/lists/*

# Frontend is the committed Vite output under src/arrsync/web/dist (build locally with: cd frontend && npm run build)
COPY . /app
RUN pip install --no-cache-dir -e .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3).read()" || exit 1

CMD ["uvicorn", "arrsync.main:app", "--host", "0.0.0.0", "--port", "8080"]
