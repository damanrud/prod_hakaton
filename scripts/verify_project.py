"""Автоматическая проверка комплекта поставки без внешних Python-библиотек.

Запуск: python scripts/verify_project.py
Коды завершения: 0 — всё на месте, 1 — есть отсутствующие/лишние файлы.
"""

from __future__ import annotations
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # Корень проекта (папка рядом с docker-compose.yml).
REQUIRED = (
    "backend/app.py", "backend/requirements.txt", "backend/tests.py", "backend/openapi.json",
    "backend/cars/cars.csv", "frontend/package-lock.json", "frontend/package.json",
    "frontend/src/App.tsx", "frontend/src/questions.ts", "frontend/src/format.tsx",
    "frontend/src/share.ts", "frontend/src/index.css", "frontend/server.mjs",
    "frontend/Dockerfile", "backend/Dockerfile", "nginx/Dockerfile",
    "nginx/default.conf", "docker-compose.yml", ".gitlab-ci.yml",
)


def verify() -> None:
    """Проверяет структуру, уникальность моделей, фотографии и OpenAPI."""
    missing = [name for name in REQUIRED if not (ROOT / name).is_file()]
    if missing:
        raise AssertionError("Нет обязательных файлов: " + ", ".join(missing))

    csv_path = ROOT / "backend/cars/cars.csv"
    image_dir = ROOT / "backend/cars/images"
    with csv_path.open(encoding="utf-8-sig", newline="") as stream:
        cars = list(csv.DictReader(stream))
    assert len(cars) == 100, f"В каталоге должно быть 100 моделей, найдено {len(cars)}"
    identifiers = [car["id"] for car in cars]
    assert len(identifiers) == len(set(identifiers)), "В каталоге есть повторяющиеся ID"
    missing_images = [car["id"] for car in cars if not (image_dir / car["image"]).is_file()]
    assert not missing_images, "Нет изображений для: " + ", ".join(missing_images)

    spec = json.loads((ROOT / "backend/openapi.json").read_text(encoding="utf-8"))
    for route in ("/api/recommend", "/api/duels", "/api/explain-car", "/api/metrics", "/api/cars"):
        assert route in spec["paths"], f"Маршрут {route} не описан в Swagger"
    question_images = list((ROOT / "frontend/public/static/images/questions").glob("*.webp"))
    assert len(question_images) >= 40, "Недостаточно изображений для вопросов"
    assert not (ROOT / "templates").exists(), "Найдена старая копия HTML-сайта"
    assert not (ROOT / "app.py").exists(), "Найдена старая копия корневого backend"
    print(f"PASS: 100 уникальных авто, {len(question_images)} иллюстраций, три сервиса, OpenAPI")


if __name__ == "__main__":
    verify()
