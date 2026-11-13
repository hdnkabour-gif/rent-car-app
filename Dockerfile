# Opt-in OCR runtime for Fleetora (use staging first). Existing production Railpack
# deployment stays unchanged until this file is reviewed and deployed explicitly.
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
    && npm cache clean --force

# Keep OCR disabled unless staging is validated and explicitly enabled.
ENV NODE_ENV=production \
    FLEETORA_OCR_ENABLED=false
EXPOSE 8080
CMD ["npm","run","start","-w","server"]
