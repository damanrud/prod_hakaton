"""Интеграционная проверка развёрнутого сайта через Nginx.

После `docker compose up --build -d`:
    python scripts/smoke_http.py http://localhost
После запуска из PyCharm: python scripts/smoke_http.py http://localhost:3000
"""
from __future__ import annotations
import json
import sys
from urllib.request import Request, urlopen

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost").rstrip("/")


def get(path: str, *, payload: dict | None = None) -> tuple[int, object]:
    """Отправляет реальный HTTP-запрос и возвращает JSON или HTML."""
    if payload is None:
        request = Request(BASE + path)
    else:
        request = Request(BASE + path, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=15) as response:
        content = response.read()
        if "application/json" in response.headers.get("Content-Type", ""):
            return response.status, json.loads(content)
        return response.status, content.decode("utf-8", "replace")


def main() -> None:
    """Проверяет реальные интеграции React -> Nginx -> Flask."""
    status, page = get("/")
    assert status == 200 and "AutoChoice" in page, "React не открывается"
    status, health = get("/health")
    assert status == 200 and health["status"] == "ok", "Backend недоступен"
    status, catalog = get("/api/catalog/status")
    assert status == 200 and catalog["count"] == 100, "Каталог загружен не полностью"
    status, cars = get("/api/cars")
    assert status == 200 and len(cars["cars"]) == 100, "API каталога не работает"
    photo = next(car["image_url"] for car in cars["cars"] if car["image_url"])
    status, _ = get(photo)
    assert status == 200, "Фото не отдаются через Nginx"
    status, duels = get("/api/duels", payload={"answers": {"3": ["city"]}})
    assert status == 200 and set(duels["duels"]) == {"11", "12", "14", "15"}, "Динамические дуэли не работают"
    status, results = get("/api/recommend", payload={"answers": {"1": "under2", "3": ["city"]}})
    assert status == 200 and results["status"] in ("matches", "no_matches"), "Алгоритм не работает"
    status, metrics = get("/api/metrics")
    assert status == 200 and metrics["requests"] >= 3, "Диагностика не работает"
    status, spec = get("/api/openapi.json")
    assert status == 200 and "/api/recommend" in spec["paths"], "OpenAPI не работает"
    status, swagger = get("/api/docs")
    assert status == 200 and "swagger" in swagger.lower(), "Swagger UI не открывается"
    print("PASS: React, Nginx, Flask, 100 автомобилей, изображения, дуэли, подбор, метрики, Swagger")


if __name__ == "__main__":
    main()
