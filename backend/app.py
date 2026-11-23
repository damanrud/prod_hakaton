"""HTTP-приложение AutoChoice: Flask-маршруты, диагностика и React для PyCharm.

Слой API не содержит формул рекомендаций и логики импорта каталога.
"""
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from contextlib import closing
from itertools import product
from flask_swagger_ui import get_swaggerui_blueprint
from flask import Flask, abort, g, jsonify, request, send_from_directory, url_for

# Блок 1. Берём только те функции, которые нужны для API.
# Имена get_profile_evidence, duels и catalog_fields также нужны старым тестам.
from catalog import (base_dir, catalog_fields, connect, empty_message,
                     image_exists, init_db, load_cars, logger, valid_image)
from engine import (duels, explain_car_choice, get_dynamic_duels,
                    get_profile_evidence, get_results, get_rules, check_rules, multi_limits,
                    question_choices, validate_request)

def create_app(config=None):
    """Собирает Flask-приложение, базу и HTTP-маршруты JSON API."""
    # React-страница при локальном python app.py, без Flask static-route конфликтов.
    app = Flask(__name__, static_folder=None)
    app.json.ensure_ascii = False
    app.config.from_mapping(
        DB_PATH=os.environ.get("AUTOCHOICE_DB_PATH") or base_dir / "autochoice.db",
        CSV_PATH=base_dir / "cars" / "cars.csv",
        IMAGE_PATH=base_dir / "cars" / "images",
        FRONTEND_DIST=base_dir.parent / "frontend" / "dist",
        FRONTEND_PUBLIC=base_dir.parent / "frontend" / "public" / "static",
        MAX_CONTENT_LENGTH=16_384,
    )
    if config:
        app.config.update(config)

    # Наблюдаемость: один простой логгер и счётчики без внешних сервисов.
    # В логи НЕ записываем ответы анкеты, бюджет или другие пользовательские данные.
    if not app.config.get("TESTING") and not any(
        isinstance(handler, logging.StreamHandler) and not isinstance(handler, logging.NullHandler)
        for handler in logger.handlers
    ):
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
        logger.setLevel(os.environ.get("AUTOCHOICE_LOG_LEVEL", "INFO").upper())
        # Для локального PyCharm можно задать AUTOCHOICE_LOG_FILE=backend/logs/autochoice.log.
        # На ВМ оставляем stdout/stderr, которые доступны через docker compose logs.
        log_filename = os.environ.get("AUTOCHOICE_LOG_FILE")
        if log_filename:
            from logging.handlers import RotatingFileHandler
            log_path = Path(log_filename).expanduser()
            log_path.parent.mkdir(parents=True, exist_ok=True)
            file_handler = RotatingFileHandler(log_path, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
            file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
            logger.addHandler(file_handler)

    started_at = time.monotonic()    # Время старта процесса: для uptime.
    last_server_error = None
    request_metrics = {}             # Агрегаты по маршрутам, без текста запросов.
    metrics_lock = threading.Lock()  # Waitress обрабатывает несколько запросов параллельно.

    @app.before_request
    def measure_request_start():
        """Запоминает начало запроса и создаёт ID для поиска ошибки в логах."""
        g.request_started = time.perf_counter()
        g.request_id = uuid.uuid4().hex[:12]

    @app.after_request
    def measure_request_finish(response):
        """Учитывает статус и длительность, не раскрывая пользовательские ответы."""
        nonlocal last_server_error
        elapsed = (time.perf_counter() - g.request_started) * 1000
        endpoint = request.url_rule.rule if request.url_rule else "<not_found>"
        key = (request.method, endpoint)
        with metrics_lock:
            entry = request_metrics.setdefault(key, {"count": 0, "errors": 0, "total_ms": 0.0})
            entry["count"] += 1
            entry["errors"] += int(response.status_code >= 500)
            entry["total_ms"] += elapsed
            if response.status_code >= 500:
                last_server_error = time.monotonic()
        response.headers["X-Request-ID"] = g.request_id
        if endpoint.startswith("/api/") and endpoint != "/api/metrics":
            level = logging.ERROR if response.status_code >= 500 else logging.INFO
            logger.log(level, "request_id=%s method=%s route=%s status=%s duration_ms=%.1f",
                        g.request_id, request.method, endpoint, response.status_code, elapsed)
        return response

    @app.get("/api/metrics")
    def service_metrics():
        """Лёгкая диагностика запросов для демо, без платного мониторинга."""
        with metrics_lock:
            recent_server_error = last_server_error is not None and time.monotonic() - last_server_error < 600
            routes = [
                {"method": method, "route": route, "requests": values["count"],
                 "server_errors": values["errors"],
                 "avg_response_ms": round(values["total_ms"] / values["count"], 2)}
                for (method, route), values in sorted(request_metrics.items())
            ]
        return jsonify(status="ok", recent_server_error=recent_server_error, uptime_seconds=round(time.monotonic() - started_at, 1),
                       requests=sum(item["requests"] for item in routes),
                       server_errors=sum(item["server_errors"] for item in routes), routes=routes)

    db_path = Path(app.config["DB_PATH"])
    csv_path = Path(app.config["CSV_PATH"])
    image_path = Path(app.config["IMAGE_PATH"])
    errors, warnings = init_db(db_path, csv_path)

    # Добавляем ссылки на фото
    def cars_with_images():
        """Читает автомобили и добавляет только безопасные ссылки на локальные фотографии."""
        cars = load_cars(db_path)
        for car in cars:
            # Техническое происхождение данных хранится в CSV, но не занимает место на карточке.
            if "демонстрационного каталога" in (car.get("description") or ""):
                car["description"] = None
        for car in cars:
            image = car["image"]
            car["image_url"] = None
            car["data_date"] = car["verified_at"]
            if image_exists(image_path, image):
                car["image_url"] = url_for("car_image", name=image)
        return cars

    # Локально Flask отдаёт готовый React dist, как старый одноконтейнерный сайт.
    # В Docker сайт по-прежнему обслуживает ОТДЕЛЬНЫЙ frontend через Nginx.
    frontend_dist = Path(app.config["FRONTEND_DIST"])

    @app.get("/")
    def index():
        """Открывает React-сайт по :8000 при обычном запуске app.py в PyCharm."""
        if (frontend_dist / "index.html").is_file():
            response = send_from_directory(frontend_dist, "index.html")
            response.headers["Cache-Control"] = "no-store"
            return response
        return ("<h1>React-сборка отсутствует</h1>"
                "<p>Запусти START_PYCHARM.bat или собери frontend: npm ci && npm run build.</p>", 503)

    @app.get("/assets/<path:filename>")
    def frontend_assets(filename):
        """Отдаёт готовые JS/CSS React, когда сайт открывают непосредственно на 8000."""
        return send_from_directory(frontend_dist / "assets", filename)

    @app.get("/monitor.html")
    def monitor_page():
        return send_from_directory(frontend_dist, "monitor.html")

    @app.get("/static/<path:filename>")
    def frontend_images(filename):
        """Отдаёт SVG и картинки вопросов из локальной React-сборки."""
        return send_from_directory(Path(app.config["FRONTEND_PUBLIC"]), filename)

    @app.get("/api/home-picks")
    def get_home_picks():
        """Выбирает разные модели для трёх сценариев главной страницы."""
        scenarios = (
            ("Для большой семьи", "Вместительный салон для поездок всей семьёй.",
             lambda car: (car["seats"] or 0) >= 6),
            ("С полным приводом", "Полный привод помогает тронуться на снегу или рыхлом грунте.",
             lambda car: car["drive"] in ("awd", "4wd")),
            ("Для дальних поездок", "По оценкам каталога, модель подходит для долгих поездок по трассе с комфортом.",
             lambda car: (car["highway"] or 0) >= 4 and (car["comfort"] or 0) >= 4),
        )
        with closing(connect(db_path)) as db:
            cars = [dict(row) for row in db.execute("SELECT * FROM cars ORDER BY RANDOM()")]

        choices = []
        for _, _, matches in scenarios:
            candidates = {}
            for car in cars:
                if matches(car):
                    model = (car["brand"].strip().casefold(), car["model"].strip().casefold())
                    candidates.setdefault(model, car)
                    # Две другие карточки могут занять максимум две подходящие модели.
                    if len(candidates) == len(scenarios):
                        break
            choices.append([*candidates.items(), None])

        best = []
        for group in product(*choices):
            selected = [(scenario, item) for scenario, item in zip(scenarios, group) if item is not None]
            if len(selected) > len(best) and len({item[0] for _, item in selected}) == len(selected):
                best = selected
                if len(best) == len(scenarios):
                    break

        picks = []
        for (title, reason, _), (_, car) in best:
            image = car.get("image")
            url = url_for("car_image", name=image) if image_exists(image_path, image) else None
            facts = [[label, car[key], unit] for key, label, unit in (
                ("seats", "Мест в салоне", ""), ("engine_power_hp", "Мощность", "л. с.")
            ) if car[key] is not None]
            picks.append({"title": title, "reason": reason, "car": car, "image_url": url, "facts": facts})
        response = jsonify(picks=picks)
        response.cache_control.no_store = True
        return response

    # Отдаём фото из каталога
    @app.get("/cars/images/<name>")
    def car_image(name):
        """Отдаёт одну фотографию из разрешённого каталога."""
        if not image_exists(image_path, name):
            abort(404)
        response = send_from_directory(image_path.resolve(), name)
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    # Показываем исходный тестовый каталог
    @app.get("/cars/catalog.csv")
    def catalog_file():
        """Возвращает исходную CSV-таблицу для технической проверки данных."""
        return send_from_directory(csv_path.parent, csv_path.name, mimetype="text/csv")

    # Возвращаем каталог машин
    @app.get("/api/cars")
    def show_cars():
        """Выдаёт весь каталог клиенту React в формате JSON."""
        return jsonify(cars=cars_with_images())

    # Показываем итоги загрузки CSV
    @app.get("/api/catalog/status")
    def catalog_status():
        """Возвращает число машин и ошибки последней синхронизации CSV."""
        with closing(connect(db_path)) as db:
            count = db.execute("SELECT COUNT(*) FROM cars").fetchone()[0]
        status = "ready" if count else "empty"
        if errors:
            status = "error"
        return jsonify(count=count, status=status, errors=errors, warnings=warnings)

    # Подбираем машины по ответам
    @app.post("/api/recommend")
    def recommend():
        """Проверяет ответы и вызывает серверный алгоритм ранжирования."""
        validated = validate_request(request.get_json(silent=True))
        if validated is None:
            return jsonify(message="Проверьте ответы и попробуйте ещё раз."), 400
        answers, balance = validated
        result = get_results(cars_with_images(), answers, balance)
        if errors and result["status"] == "empty":
            return jsonify(message="Каталог временно недоступен. Проверьте файл cars.csv."), 503
        if errors:
            result["notes"].append("Используются данные последнего успешного импорта каталога.")
        return jsonify(result)

    # Персональные фотографии для визуальных вопросов.
    @app.post("/api/duels")
    def dynamic_duels():
        """Подбирает контрастные изображения дуэлей по рациональным ответам."""
        validated = validate_request(request.get_json(silent=True))
        if validated is None:
            return jsonify(message="Проверьте ответы."), 400
        return jsonify(duels=get_dynamic_duels(validated[0], cars_with_images()))

    # Объяснение по любой модели каталога.
    @app.post("/api/explain-car")
    def explain_car():
        """Объясняет попадание или исключение указанной модели."""
        payload = request.get_json(silent=True)
        validated = validate_request(payload)
        if validated is None or not isinstance(payload.get("car_id"), str):
            return jsonify(message="Выберите автомобиль и проверьте ответы."), 400
        cars = cars_with_images()
        car = next((item for item in cars if item["id"] == payload["car_id"]), None)
        if car is None:
            return jsonify(message="Автомобиль отсутствует в каталоге."), 404
        return jsonify(explain_car_choice(car, validated[0], cars, validated[1]))

    # Проверяем доступность базы
    @app.get("/health")
    def health():
        """Подтверждает, что SQLite доступна и отвечает на запрос."""
        with closing(connect(db_path)) as db:
            db.execute("SELECT id FROM cars LIMIT 1").fetchone()
        return jsonify(status="ok")

    @app.get("/api/question-contract")
    def question_contract():
        """Один серверный контракт допустимых значений для React и Swagger."""
        return jsonify(version=1, questions={
            number: {"values": sorted(choices), "multi": number in multi_limits,
                     "max_items": multi_limits.get(number, 1)}
            for number, choices in question_choices.items()
        })

    @app.get("/api/openapi.json")
    @app.get("/openapi.json")
    def openapi_json():
        """Swagger берёт варианты ответов из того же источника, что валидатор Python."""
        spec = json.loads((base_dir / "openapi.json").read_text(encoding="utf-8"))
        properties = spec["components"]["schemas"]["Answers"]["properties"]
        for number, choices in question_choices.items():
            field = properties[number]
            values = sorted(choices)
            if number in multi_limits:
                field["oneOf"][0]["items"]["enum"] = values
                field["oneOf"][0]["maxItems"] = multi_limits[number]
            else:
                field["enum"] = values + ["skip", None]
        return jsonify(spec)

    ui = get_swaggerui_blueprint("/api/docs", "/api/openapi.json", config={
        "app_name": "AutoChoice API", "validatorUrl": None, "tryItOutEnabled": True,
    })
    app.register_blueprint(ui)
    app.add_url_rule("/api/docs", "api_docs", app.view_functions["swagger_ui.show"])
    app.add_url_rule("/docs", "docs", app.view_functions["swagger_ui.show"])
    app.add_url_rule("/docs/", "docs_slash", app.view_functions["swagger_ui.show"])

    @app.errorhandler(413)
    def request_too_large(_error):
        """Возвращает понятную ошибку при слишком большом запросе."""
        return jsonify(message="Максимальный размер запроса — 16 КиБ."), 413

    # Сообщаем о недоступном каталоге
    @app.errorhandler(sqlite3.Error)
    def database_error(error):
        """Пишет ошибку базы в логи без пользовательских ответов, клиенту даёт 503."""
        logger.error("request_id=%s database_error=%s", getattr(g, "request_id", "unknown"), type(error).__name__)
        return jsonify(message="Каталог временно недоступен.", status="error"), 503

    return app


if __name__ == "__main__":
    # Запускаем локальный сайт
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    app = create_app()
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    print(f"AutoChoice (React) открыт на http://{host}:{port}/", flush=True)
    app.run(host=host, port=port)
