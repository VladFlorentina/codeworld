FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install shared packages first
COPY packages/db /packages/db
RUN pip install --no-cache-dir -e /packages/db

COPY packages/github_app /packages/github_app
RUN pip install --no-cache-dir -e /packages/github_app

# Install API requirements
COPY apps/api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY apps/api/pyproject.toml .
COPY apps/api/app/ app/
RUN pip install --no-cache-dir -e .

COPY apps/api/ .

EXPOSE 8000
