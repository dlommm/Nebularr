# syntax=docker/dockerfile:1
# Multi-stage: wheel build (no repo dev junk), minimal runtime, non-root.

FROM python:3.13-slim AS builder

WORKDIR /build

RUN apt-get update \
    && apt-get upgrade -y -o Dpkg::Options::="--force-confold" \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY src ./src
COPY alembic.ini ./
COPY alembic ./alembic

# hadolint DL3013: pin bootstrap tooling for reproducible wheel builds.
RUN pip install --no-cache-dir pip==26.0.1 setuptools==82.0.1 wheel==0.47.0 \
    && pip wheel --no-cache-dir --wheel-dir /wheels .

FROM python:3.13-slim AS runtime

ARG APP_VERSION=1.6.0
ARG GIT_SHA=release

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=random \
    APP_VERSION=${APP_VERSION} \
    APP_GIT_SHA=${GIT_SHA}

WORKDIR /app

RUN apt-get update \
    && apt-get upgrade -y -o Dpkg::Options::="--force-confold" \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels nebularr \
    && rm -rf /wheels

COPY alembic.ini ./
COPY alembic ./alembic

RUN groupadd --system --gid 1001 nebularr \
    && useradd --uid 1001 --gid nebularr --home-dir /app --shell /usr/sbin/nologin --no-create-home nebularr \
    && mkdir -p /app/data \
    && chown -R 1001:1001 /app

USER 1001:1001

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3).read()" || exit 1

CMD ["uvicorn", "arrsync.main:app", "--host", "0.0.0.0", "--port", "8080"]
