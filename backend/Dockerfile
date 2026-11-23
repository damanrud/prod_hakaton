# Блок 1: отдельный Python API — без React и Nginx внутри контейнера.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py catalog.py engine.py openapi.json ./
COPY cars/ ./cars/
RUN useradd --create-home --uid 10001 autochoice && mkdir -p /data && chown 10001:10001 /data
ENV PYTHONUNBUFFERED=1 AUTOCHOICE_DB_PATH=/data/autochoice.db
USER autochoice
EXPOSE 8000
CMD ["waitress-serve", "--call", "--listen=0.0.0.0:8000", "app:create_app"]
