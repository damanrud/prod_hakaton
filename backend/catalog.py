"""Каталог AutoChoice: проверка CSV, схема SQLite, безопасная загрузка данных.

Функции не знают об HTTP и рекомендациях: отвечают только за хранение.
"""
import csv
import json
import logging
import math
import sqlite3
from contextlib import closing
from datetime import date
from pathlib import Path

base_dir = Path(__file__).resolve().parent

# Записи для подключённых обработчиков
logger = logging.getLogger("autochoice")
logger.addHandler(logging.NullHandler())
logger.propagate = False

# Точное целое в JavaScript
safe_integer = 9_007_199_254_740_991
image_types = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}
empty_message = "Каталог автомобилей пока не заполнен. Рекомендации появятся после добавления моделей."

# Столбцы каталога
required_fields = ("id", "brand", "model")
score_fields = (
    "safety", "reliability", "comfort", "dynamics", "economy", "maintenance",
    "city", "highway", "gravel", "offroad", "family", "daily_use", "cargo",
    "driving_fun", "classic", "futuristic", "sport_style", "elegant",
    "cozy_interior", "tech_interior", "bright", "minimalist", "sedan_style",
    "crossover_style",
)
catalog_fields = required_fields + (
    "trim", "year", "condition", "price_rub", "body_type", "car_size", "seats",
    "transmission", "drive", "fuel_type", "hybrid_type", "engine_power_hp",
    "boot_l", "clearance_mm", "fuel_consumption",
) + score_fields + ("image", "source", "verified_at", "description")

# Ограничения для столбцов
int_limits = {
    "year": (1886, 2100), "price_rub": (1, safe_integer), "seats": (1, 99),
    "engine_power_hp": (1, safe_integer), "boot_l": (0, safe_integer),
    "clearance_mm": (0, safe_integer),
}
allowed_values = {
    "condition": {"new", "used"},
    "body_type": {
        "sedan", "hatchback", "wagon", "liftback", "coupe", "convertible",
        "crossover", "suv", "minivan", "pickup", "van", "other",
    },
    "car_size": {"small", "medium", "large"},
    "transmission": {"manual", "automatic", "robot", "cvt"},
    "drive": {"fwd", "rwd", "awd", "4wd"},
    "fuel_type": {"petrol", "diesel", "hybrid", "electric"},
    "hybrid_type": {"plug_in", "regular"},
}

# Проверяем имя фотографии
def valid_image(name):
    """Проверяет безопасное имя локальной фотографии, не позволяя выйти из каталога."""
    if not name or name.startswith("."):
        return False
    if any(char in "/\\:" or ord(char) < 32 for char in name):
        return False
    return Path(name).suffix.lower() in image_types


# Ищем фото внутри каталога
def image_exists(folder, name):
    """Проверяет, что выбранная фотография действительно находится в каталоге."""
    if not valid_image(name):
        return False
    try:
        photo = (folder / name).resolve()
        return photo.parent == folder.resolve() and photo.is_file()
    except (OSError, RuntimeError, ValueError):
        return False


# Приводим значения CSV
def parse_cell(key, value):
    """Преобразует текст CSV в допустимое значение или неизвестное None."""
    if key in int_limits:
        number = int(value)
        low, high = int_limits[key]
        if not low <= number <= high:
            raise ValueError
        return number
    if key in score_fields or key == "fuel_consumption":
        number = float(value)
        if not math.isfinite(number) or number < 0 or (key in score_fields and number > 5):
            raise ValueError
        return number
    if key in allowed_values:
        value = value.lower()
        if value not in allowed_values[key]:
            raise ValueError
    if key == "image" and not valid_image(value):
        raise ValueError
    if key == "verified_at" and date.fromisoformat(value).isoformat() != value:
        raise ValueError
    return value


# Читаем каталог из CSV
def read_catalog(path):
    """Считывает и проверяет CSV; ошибки возвращает без повреждения базы."""
    rows = []
    warnings = []
    ids = set()
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream, strict=True)
        header = reader.fieldnames
        if not header or sorted(header) != sorted(catalog_fields):
            raise ValueError("Сохраните исходные заголовки cars.csv.")

        for row in reader:
            line = reader.line_num
            if not any(row.values()):
                continue
            if None in row or any(value is None for value in row.values()):
                warnings.append(f"Строка {line}. Проверьте число столбцов.")
                continue
            values = {key: (row[key] or "").strip() for key in catalog_fields}
            if not any(values.values()):
                continue
            if any(not values[key] or values[key].lower() == "n/a" for key in required_fields):
                warnings.append(f"Строка {line}. Нужны уникальный ID, марка и модель.")
                continue
            if values["id"] in ids:
                warnings.append(f"Строка {line}. Повторяющийся ID пропущен.")
                continue
            ids.add(values["id"])
            # Отмечаем пропуски и ошибки
            car = {}
            quality = {}
            for key, value in values.items():
                car[key] = None
                if not value:
                    continue
                if value.lower() == "n/a":
                    quality[key] = "not_applicable"
                    continue
                try:
                    car[key] = parse_cell(key, value)
                except ValueError:
                    quality[key] = "invalid"
                    warnings.append(f"Строка {line}. Некорректное значение в столбце {key}.")

            if car["fuel_type"] in {"petrol", "diesel", "electric"}:
                if car["hybrid_type"] is not None:
                    quality["hybrid_type"] = "invalid"
                    warnings.append(f"Строка {line}. Подтип указан у автомобиля без гибрида.")
                else:
                    quality.setdefault("hybrid_type", "not_applicable")
                car["hybrid_type"] = None

            rows.append(tuple(car[key] for key in catalog_fields) + (json.dumps(quality),))
    return rows, warnings


# Открываем базу SQLite
def connect(path):
    """Открывает SQLite и настраивает доступ к строкам по названиям столбцов."""
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    return db


# Обновляем данные по ID
def init_db(path, csv_path):
    """Синхронизирует CSV с SQLite внутри транзакции и сохраняет данные при ошибке."""
    path.parent.mkdir(parents=True, exist_ok=True)
    columns = {key: "INTEGER" if key in int_limits else "TEXT" for key in catalog_fields}
    columns.update({key: "REAL" for key in score_fields + ("fuel_consumption",)})
    columns["id"] = "TEXT PRIMARY KEY NOT NULL"
    columns["brand"] = "TEXT NOT NULL"
    columns["model"] = "TEXT NOT NULL"
    columns["quality"] = "TEXT NOT NULL"
    definitions = ", ".join(f"{key} {kind}" for key, kind in columns.items())
    with closing(connect(path)) as db, db:
        db.execute(f"CREATE TABLE IF NOT EXISTS cars ({definitions})")
        try:
            rows, warnings = read_catalog(csv_path)
        except (OSError, csv.Error, ValueError) as error:
            logger.warning("Каталог не загружен: %s", error)
            return ["Проверьте наличие, заголовки и кодировку UTF-8 файла cars.csv."], []

        previous = db.execute("SELECT EXISTS(SELECT 1 FROM cars)").fetchone()[0]
        if previous and (warnings or not rows):
            return ["Импорт отклонён. Сохранён предыдущий каталог."], warnings
        if warnings:
            logger.warning("Замечания к каталогу: %s", len(warnings))

        # Обновляем существующие строки
        names = ", ".join(columns)
        placeholders = ", ".join("?" for _ in columns)
        updates = ", ".join(f"{key} = excluded.{key}" for key in columns if key != "id")
        db.executemany(
            f"INSERT INTO cars ({names}) VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {updates}",
            rows,
        )
        if rows:
            db.execute("CREATE TEMP TABLE imported_ids (id TEXT PRIMARY KEY)")
            db.executemany("INSERT INTO imported_ids VALUES (?)", ((row[0],) for row in rows))
            db.execute("DELETE FROM cars WHERE id NOT IN (SELECT id FROM imported_ids)")
    return [], warnings


# Подробности экспертных ориентиров отделены от исходных характеристик CSV.
# Это НЕ рейтинги Euro NCAP, IIHS или ADAC для конкретной комплектации.
assessments_file = base_dir / "cars" / "assessments.csv"


def load_assessment_notes():
    """Читает пояснения оценок, не выдавая ориентиры за официальные испытания.

    Проверяем совпадение баллов с основным CSV. Иначе не показываем
    устаревшее пояснение, например если модель впоследствии была перепроверена.
    """
    if not assessments_file.is_file():
        return {}
    with assessments_file.open(encoding="utf-8-sig", newline="") as stream:
        return {row["id"]: row for row in csv.DictReader(stream)}


# Загружаем машины из SQLite
def load_cars(db_path):
    """Читает актуальные автомобили из базы и происхождение модельных оценок."""
    with closing(connect(db_path)) as db:
        cars = [dict(row) for row in db.execute("SELECT * FROM cars ORDER BY id")]
    notes = load_assessment_notes()
    for car in cars:
        car["quality"] = json.loads(car["quality"])
        row = notes.get(car["id"])
        if row and all(
            car[name] is not None and float(row[name]) == float(car[name])
            for name in ("safety", "reliability")
        ):
            car["rating_provenance"] = {
                "safety": "estimated", "reliability": "estimated",
                "basis": row["assessment_basis"],
                "disclaimer": "Предварительные баллы AutoChoice, не официальные краш-тесты или статистика поломок.",
            }
    return cars


# Проверяем число и границы
def valid_number(value, low, high):
    """Проверяет числовое значение в заданном диапазоне."""
    return type(value) in (int, float) and low <= value <= high


# Проверяем ответы опроса
