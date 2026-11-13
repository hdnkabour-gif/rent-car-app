# Fleetora OCR + backup runtime. PostgreSQL client binaries are needed for
# pg_dump / pg_restore; the running database is never installed in this image.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    FLEETORA_OCR_PYTHON=/opt/fleetora-ocr/bin/python \
    FLEETORA_OCR_LANG=fra+eng+ara
WORKDIR /app

# Language packs, PDF conversion and Python are installed in the immutable image.
# Do not put these packages or virtualenv on the Railway /data volume.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra \
      tesseract-ocr-ara poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# PostgreSQL backups require a client of the SAME major version as the source DB:
# production currently PostgreSQL 16, isolated staging PostgreSQL 18.
# Use the PostgreSQL project's official signed Debian APT repository (PGDG).
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && install -d -m 0755 /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error --location \
         https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 postgresql-client-18 \
    && /usr/lib/postgresql/16/bin/pg_dump --version \
    && /usr/lib/postgresql/18/bin/pg_dump --version \
    && rm -rf /var/lib/apt/lists/*

COPY server/tools/requirements-ocr.txt /tmp/requirements-ocr.txt
RUN python3 -m venv /opt/fleetora-ocr \
    && /opt/fleetora-ocr/bin/python -m pip install --no-cache-dir \
      --disable-pip-version-check -r /tmp/requirements-ocr.txt \
    && /opt/fleetora-ocr/bin/python -c "import cv2, numpy, pytesseract, PIL; print('OCR Python libraries ready')" \
    && tesseract --list-langs 2>&1 | grep -Eq '^ara$' \
    && tesseract --list-langs 2>&1 | grep -Eq '^fra$' \
    && tesseract --list-langs 2>&1 | grep -Eq '^eng$'

COPY package*.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
RUN npm ci

COPY . .
RUN npm run build \
    && /opt/fleetora-ocr/bin/python -m unittest discover -s server/tools -p 'test_*.py' \
    && npm prune --omit=dev \
    && node -e "Promise.all(['express','pg','zod','helmet','pino'].map(x => import(x))).then(() => console.log('Runtime dependencies ready'))" \
    && npm cache clean --force

# Keep OCR disabled unless staging is validated and explicitly enabled.
ENV NODE_ENV=production \
    FLEETORA_OCR_ENABLED=false
EXPOSE 8080
CMD ["npm","run","start","-w","server"]
