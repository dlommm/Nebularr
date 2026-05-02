# syntax=docker/dockerfile:1
# Multi-stage: wheel build (no repo dev junk), minimal runtime, non-root.
# Base: Python 3.14 slim (matches official refresh on Debian trixie; aligns with Scout base-image bumps).

FROM python:3.14-slim AS builder

WORKDIR /build

RUN apt-get update \
    && apt-get upgrade -y -o Dpkg::Options::="--force-confold" \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY src ./src
COPY alembic.ini ./
COPY alembic ./alembic

# hadolint DL3013: pin bootstrap tooling for reproducible wheel builds.
RUN pip install --no-cache-dir pip==26.1 setuptools==82.0.1 wheel==0.47.0 \
    && pip wheel --no-cache-dir --wheel-dir /wheels .

FROM python:3.14-slim AS runtime

ARG APP_VERSION=1.9.3
ARG GIT_SHA=release

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=random \
    DEBIAN_FRONTEND=noninteractive \
    APP_VERSION=${APP_VERSION} \
    APP_GIT_SHA=${GIT_SHA}

WORKDIR /app

# Refresh OS + pull fixed libcap2 from sid until trixie catalog carries >= 1:2.78-1 (CVE-2026-4878 upstream fix path).
RUN apt-get update \
    && apt-get upgrade -y -o Dpkg::Options::="--force-confold" \
    && echo deb http://deb.debian.org/debian sid main > /etc/apt/sources.list.d/debian-sid.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends libcap2/sid \
    && rm -f /etc/apt/sources.list.d/debian-sid.list \
    && apt-get update \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir pip==26.1 \
    && pip install --no-cache-dir --no-index --find-links=/wheels nebularr \
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
