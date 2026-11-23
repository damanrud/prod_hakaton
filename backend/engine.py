"""Рекомендательный движок AutoChoice.

Все правила, формулы и объяснения сосредоточены здесь и не зависят от Flask.
"""
import math
from collections import Counter
from itertools import product
from catalog import allowed_values, empty_message, safe_integer, score_fields, valid_number

# Допустимые ответы опроса
question_choices = {
    "1": {"under2", "2to5", "over5", "custom"},
    "2": {"new", "used", "both", "unsure"},
    "3": {"city", "highway", "gravel", "offroad"},
    "4": {"daily", "family", "fun", "cargo"},
    "5": {"two", "four", "five", "six"},
    "6": {"light", "cases", "large", "equipment"},
    "7": {"automatic", "awd", "boot", "engine"},
    "8": allowed_values["car_size"],
    "9": {"calm", "sport", "power", "practical"},
    "10": {"safety", "comfort", "dynamics", "economy"},
}
duels = {
    "11": ("classic", "futuristic"),
    "12": ("sport_style", "elegant"),
    "13": ("cozy_interior", "tech_interior"),
    "14": ("sedan_style", "crossover_style"),
    "15": ("bright", "minimalist"),
}
question_choices.update({key: {"a", "b", "both", "neither"} for key in duels})

# Лимиты множественного выбора
multi_limits = {"3": 4, "4": 4, "7": 4, "9": 2, "10": 2}
extra_fields = {"budgetMax", "minSeats", "engine", "hybrid"}

# Значения вариантов опроса
budgets = {"under2": 2_000_000, "2to5": 5_000_000}
seat_options = {"two": 2, "four": 4, "five": 5, "six": 6}
cargo_target = {"light": 200, "cases": 350, "large": 600, "equipment": 450}
sizes = ("small", "medium", "large")

# Веса рациональных предпочтений
base_weights = {"safety": 1, "reliability": 1, "comfort": 1, "economy": 1}
preference_weights = {
    "4": {
        "daily": {"daily_use": 5, "economy": 2, "maintenance": 2},
        "family": {"family": 5, "capacity": 3, "comfort": 3, "safety": 2},
        "fun": {"driving_fun": 5, "dynamics": 3},
        "cargo": {"cargo": 4, "capacity": 4, "gravel": 2},
    },
    "9": {
        "calm": {"comfort": 5, "highway": 2},
        "sport": {"dynamics": 5, "driving_fun": 3},
        "power": {"dynamics": 4, "engine_power_hp": 2, "gravel": 2},
        "practical": {"economy": 4, "daily_use": 3, "maintenance": 3},
    },
    "10": {
        "safety": {"safety": 6, "reliability": 6},
        "comfort": {"comfort": 6},
        "dynamics": {"dynamics": 6, "driving_fun": 4},
        "economy": {"economy": 6, "maintenance": 6},
    },
}

# Подписи для объяснений
labels = {
    "safety": "безопасность", "reliability": "надёжность", "comfort": "комфорт",
    "dynamics": "динамика", "economy": "экономичность", "maintenance": "доступность обслуживания",
    "city": "пригодность для города", "highway": "пригодность для трассы",
    "gravel": "пригодность для грунтовых дорог", "offroad": "пригодность для бездорожья",
    "family": "пригодность для семейных поездок", "daily_use": "пригодность для ежедневных поездок",
    "cargo": "удобство перевозки вещей", "driving_fun": "удовольствие от вождения",
    "capacity": "вместительность багажника", "size": "предпочитаемый размер кузова",
    "engine_power_hp": "мощность двигателя", "classic": "классический дизайн",
    "futuristic": "футуристичный дизайн", "sport_style": "спортивный дизайн",
    "elegant": "элегантный дизайн", "cozy_interior": "уютный интерьер",
    "tech_interior": "технологичный интерьер", "bright": "яркий дизайн",
    "minimalist": "минималистичный дизайн", "sedan_style": "силуэт седана",
    "crossover_style": "силуэт кроссовера",
}
engine_labels = {
    "petrol": "Бензиновый двигатель", "diesel": "Дизельный двигатель",
    "hybrid": "Гибридный двигатель", "electric": "Электрический двигатель",
}


def validate_request(payload):
    """Проверяет ответы и дополнительные поля до вычисления рекомендаций."""
    if not isinstance(payload, dict) or not isinstance(payload.get("answers"), dict):
        return None
    balance = payload.get("balance", 50)
    if not valid_number(balance, 0, 100):
        return None
    source = payload["answers"]
    if source.keys() - (question_choices.keys() | extra_fields):
        return None

    answers = {}
    for key, options in question_choices.items():
        value = source.get(key)
        if value is None or value == "skip":
            continue
        if key in multi_limits:
            if (
                not isinstance(value, list) or len(value) > multi_limits[key]
                or any(not isinstance(item, str) or item not in options for item in value)
                or len(set(value)) != len(value)
            ):
                return None
        elif not isinstance(value, str) or value not in options:
            return None
        answers[key] = value

    # Сохраняем выбранные уточнения
    if answers.get("1") == "custom":
        value = source.get("budgetMax")
        if type(value) is not int or not 1 <= value <= safe_integer:
            return None
        answers["budgetMax"] = value
    if answers.get("5") == "six":
        value = source.get("minSeats", 6)
        if type(value) is not int or not 6 <= value <= 99:
            return None
        answers["minSeats"] = value
    if "engine" in answers.get("7", []):
        engine = source.get("engine")
        if not isinstance(engine, str) or engine not in allowed_values["fuel_type"]:
            return None
        answers["engine"] = engine
        if engine == "hybrid":
            hybrid = source.get("hybrid", "any")
            if not isinstance(hybrid, str) or hybrid not in allowed_values["hybrid_type"] | {"any"}:
                return None
            answers["hybrid"] = hybrid
    return answers, balance


# Собираем строгие ограничения
def get_rules(answers):
    """Создаёт список обязательных требований, которые нельзя нарушать."""
    rules = []
    budget = answers.get("budgetMax", budgets.get(answers.get("1")))
    seats = answers.get("minSeats", seat_options.get(answers.get("5")))
    condition = answers.get("2")
    required = answers.get("7", [])
    if budget is not None:
        price = f"{budget:,}".replace(",", " ").replace(".", ",")
        label = f"Цена до {price} ₽"
        rules.append((1, "price_rub", label, lambda value: value <= budget))
    if condition in {"new", "used"}:
        label = "Новый автомобиль" if condition == "new" else "Автомобиль с пробегом"
        rules.append((2, "condition", label, lambda value: value == condition))
    if seats is not None:
        rules.append((5, "seats", f"Мест не меньше {seats}", lambda value: value >= seats))
    if "automatic" in required:
        rules.append((7, "transmission", "Автоматическая коробка", lambda value: value in {"automatic", "robot", "cvt"}))
    if "awd" in required:
        rules.append((7, "drive", "Полный привод", lambda value: value in {"awd", "4wd"}))
    if "boot" in required:
        rules.append((7, "boot_l", "Багажник от 450 л", lambda value: value >= 450))
    engine = answers.get("engine")
    if engine:
        rules.append((7, "fuel_type", engine_labels[engine], lambda value: value == engine))
    hybrid = answers.get("hybrid")
    if hybrid in allowed_values["hybrid_type"]:
        label = "Подключаемый гибрид" if hybrid == "plug_in" else "Обычный гибрид"
        rules.append((7, "hybrid_type", label, lambda value: value == hybrid))
    return rules


# Отмечаем невыполненные условия
def check_rules(car, rules):
    """Проверяет один автомобиль: нарушенные и неизвестные условия."""
    failures = {}
    for _, key, _, check in rules:
        value = car[key]
        if value is None:
            failures[key] = "unknown"
        elif not check(value):
            failures[key] = "rejected"
    return failures


# Учитываем практические предпочтения
def get_weights(answers):
    """Превращает рациональные ответы в веса характеристик."""
    weights = Counter(base_weights)
    weights.update({key: 4 for key in answers.get("3", [])})
    for question, choices in preference_weights.items():
        for choice in answers.get(question, []):
            weights.update(choices[choice])
    if answers.get("6"):
        weights.update({"capacity": 5, "cargo": 2})
    if answers.get("8"):
        weights["size"] = 5
    return weights


# Опрос можно проходить частично. Различаем три независимые вещи:
# 1) сколько вопросов нажато; 2) сколько содержательных сведений получено;
# 3) оценку конкретной машины по ДОСТУПНЫМ предпочтениям пользователя.
full_profile_answers = 7
survey_questions = tuple(str(number) for number in range(1, 16))


def informative_answer(question, answer):
    """Не считает «не знаю», «оба варианта состояния» и «ни один дизайн» вкусом.

    Бюджет и требования к машине считаются информативными ограничениями,
    но НЕ повышают совместимость без реальных оцениваемых предпочтений.
    """
    if question == "1":
        return answer in {"under2", "2to5", "custom"}
    if question == "2":
        return answer in {"new", "used"}
    if question in duels:
        return answer in {"a", "b", "both"}
    return bool(answer)


def profile_details(answers):
    """Заполненность, информативность и игровое ограничение баллов — отдельно."""
    completed = sum(bool(answers.get(q)) for q in survey_questions)
    meaningful = sum(bool(informative_answer(q, answers.get(q))) for q in survey_questions)
    preferences = get_preference_evidence(answers)
    return {
        "completed": completed,
        "answered": meaningful,  # прежнее имя поля для совместимости с UI
        "informative": meaningful,
        "preference_answers": preferences,
        "constraint_answers": meaningful - preferences,
        "recommended": full_profile_answers,
        "confidence": round(min(1.0, meaningful * .15), 2),
    }


def get_profile_evidence(answers):
    """Возвращает количество содержательных ответов и игровой предел балла."""
    profile = profile_details(answers)
    return profile["informative"], profile["confidence"]


def get_preference_evidence(answers):
    """Число положительных ответов о вкусах (не включает бюджет и нейтральные ответы)."""
    questions = ("3", "4", "6", "8", "9", "10", *duels)
    return sum(bool(informative_answer(q, answers.get(q))) for q in questions)


def personal_weights(weights):
    """Исключает базовые веса: без пожеланий нет персональной оценки."""
    return {key: value - base_weights.get(key, 0) for key, value in weights.items()
            if value > base_weights.get(key, 0)}


# Добавляем оценки по характеристикам
def practical_values(car, answers):
    """Добавляет вычисляемые оценки размеров, багажника и мощности."""
    values = {key: car[key] for key in score_fields}
    boot = car["boot_l"]
    if boot is not None:
        target = cargo_target.get(answers.get("6"), 450)
        values["capacity"] = min(5, 5 * boot / target)
    size = car["car_size"]
    if size and answers.get("8"):
        difference = abs(sizes.index(size) - sizes.index(answers["8"]))
        values["size"] = 5 - 2.5 * difference
    power = car["engine_power_hp"]
    if power is not None:
        values["engine_power_hp"] = min(5, power / 50)
    clearance = car["clearance_mm"]
    if clearance is not None:
        for key, target in (("gravel", 175), ("offroad", 220)):
            if values[key] is None:
                values[key] = min(5, 5 * clearance / target)
    return values


# Собираем оценки визуального выбора
def get_tastes(answers):
    """Преобразует визуальные дуэли в веса стилевых предпочтений."""
    weights = {}
    for key, (first, second) in duels.items():
        choice = answers.get(key)
        if choice == "a":
            weights[first] = 1
        elif choice == "b":
            weights[second] = 1
        elif choice == "both":
            weights.update({first: 0.5, second: 0.5})
    return weights


# Оценка по известным значениям
def get_score(values, weights):
    """Вычисляет взвешенную совместимость только по известным данным."""
    known = {key: values[key] for key in weights if values.get(key) is not None}
    known_weight = sum(weights[key] for key in known)
    if not known_weight:
        return None, known
    score = 20 * math.fsum(known[key] * weights[key] for key in known) / known_weight
    return round(score, 1), known


# Объясняем плюсы и компромиссы
def get_explanations(known, weights, high, car=None):
    """Составляет объяснения по наиболее значимым известным характеристикам."""
    order = -1 if high else 1
    features = sorted(known, key=lambda key: (-weights[key], order * known[key], key))
    details = []
    for key in features:
        value = known[key]
        if (high and value < 4) or (not high and value > 2):
            continue
        label = labels[key]
        if car and key in {"gravel", "offroad"} and car[key] is None:
            label = f"дорожный просвет {car['clearance_mm']} мм для поездок вне асфальта"
        if car and key == "capacity":
            label = f"объём багажника {car['boot_l']} л"
        title = "Сильная сторона" if high else "Возможный компромисс"
        details.append(f"{title} — {label}.")
    return details[:3]


# Считаем рейтинг одной машины
def rate_car(car, answers, balance, rules, weights, tastes):
    """Считает рациональный, эмоциональный и общий рейтинг одного автомобиля."""
    practical = practical_values(car, answers)
    # Базовые веса нужны для служебной аналитики, но не являются личным вкусом.
    personal = personal_weights(weights)
    reason, facts = get_score(practical, personal)
    rational_weight = sum(personal.values())
    completeness = sum(personal[key] for key in facts) / rational_weight if rational_weight else 0
    adjusted_reason = None if reason is None else completeness * reason + (1 - completeness) * 50
    heart, styles = get_score(car, tastes)
    visual_share = sum(tastes.values()) / len(duels)
    heart_completeness = (sum(tastes[key] for key in styles) / sum(tastes.values())) if tastes else None
    adjusted_heart = heart_completeness * heart + (1 - heart_completeness) * 50 if heart is not None else None

    # Смешиваем только реально рассчитанные направления; не подставляем 50 за отсутствующее.
    share = balance / 100 * visual_share
    if balance > 50:
        share = .5 * visual_share + (balance - 50) / 50 * (1 - .5 * visual_share)
    if reason is not None and heart is not None:
        total = round((1 - share) * reason + share * heart, 1)
        total_adjusted = round((1 - share) * adjusted_reason + share * adjusted_heart, 1)
    elif reason is not None:
        total, total_adjusted = reason, round(adjusted_reason, 1)
    elif heart is not None:
        total, total_adjusted = heart, round(adjusted_heart, 1)
    else:
        total = total_adjusted = None

    answered_questions, profile_scale = get_profile_evidence(answers)
    if total_adjusted is not None:
        total_adjusted = round(total_adjusted * profile_scale, 1)

    reasons = get_explanations(facts, personal, high=True, car=car)
    reasons.extend(
        f"Соответствует визуальному выбору — {labels[key]}."
        for key in sorted(styles, key=lambda field: (-styles[field] * tastes[field], field))
        if styles[key] >= 4
    )
    reasons = reasons[:3]
    if rules and not check_rules(car, rules):
        limits = ", ".join(label.lower() for _, _, label, _ in rules)
        reasons.append(f"Подтверждены обязательные условия — {limits}.")
    if not reasons and reason is not None:
        strongest = max(facts, key=lambda key: (facts[key] * personal[key], key))
        reasons.append(f"При расчёте учтена характеристика «{labels[strongest]}».")
    if not reasons and heart is not None:
        strongest = max(styles, key=lambda key: (styles[key] * tastes[key], key))
        reasons.append(f"При расчёте учтена характеристика «{labels[strongest]}».")
    if not reasons:
        reasons.append("Для индивидуальной оценки пока мало характеристик.")

    # Показываем полноту данных
    notes = []
    # Полнота исходных данных остаётся в числовых полях API; не загромождаем карточку счётчиками.
    # Сами характеристики не подменяем нулями или вымышленными значениями.
    if reason is None and heart is not None:
        notes.append("Оценка рассчитана только по известным визуальным предпочтениям.")
    if heart is None and reason is not None:
        notes.append("Итог рассчитан по практической оценке. Для оценки стиля пока недостаточно данных.")
    tradeoffs = get_explanations(facts, personal, high=False, car=car) + get_explanations(styles, tastes, high=False)
    if not tradeoffs:
        # Показываем относительный компромисс только среди выбранных предпочтений.
        considered = {key: value for key, value in facts.items() if personal.get(key, 0) > 0}
        considered.update(styles)
        if considered:
            weakest = min(considered, key=lambda key: (considered[key], key))
            if considered[weakest] < 5:
                score = f"{considered[weakest]:.1f}".rstrip("0").rstrip(".").replace(".", ",")
                tradeoffs.append(f"Слабее других пожеланий оценена характеристика «{labels[weakest]}» ({score} из 5).")
    return {
        **car,
        "reason": reason, "reason_adjusted": round(adjusted_reason, 1) if adjusted_reason is not None else None,
        "heart": heart, "total": total, "completeness": completeness,
        "heart_adjusted": round(adjusted_heart, 1) if adjusted_heart is not None else None,
        "heart_completeness": heart_completeness,
        "data_coverage": (sum(personal[key] for key in facts) + sum(tastes[key] for key in styles)) / (sum(personal.values()) + sum(tastes.values())) if (personal or tastes) else 0,
        "total_adjusted": total_adjusted,
        "profile_answer_count": answered_questions,
        "profile_confidence": profile_scale,
        "reasons": reasons[:3],
        "unknown": [labels[k] for k in (*personal, *tastes) if k not in facts and k not in styles],
        "tradeoffs": tradeoffs,
        "notes": notes,
    }


# Ранжируем только подходящие машины
def get_results(cars, answers, balance):
    """Сначала фильтрует машины по ограничениям, затем ранжирует и выбирает топ."""
    result = {
        "reason": [], "heart": [], "balance": [], "count": 0, "totalCatalog": len(cars),
        "status": "empty", "message": empty_message, "notes": [],
        "filters": [], "filterDetails": [], "compromises": [], "picks": [],
        "dna": build_user_dna(answers),
        "personalization": profile_details(answers),
    }
    if not cars:
        return result

    # Пустая анкета не означает, что автомобили не подходят: мы ещё ничего
    # не узнали о человеке. Не выдаём случайный топ на базовых весах.
    if profile_details(answers)["informative"] == 0:
        result["status"] = "needs_answers"
        result["message"] = ("Недостаточно содержательных ответов. Выбери конкретное условие "
                             "или предпочтение: нейтральные ответы не формируют подбор.")
        return result

    rules = get_rules(answers)
    weights = get_weights(answers)
    tastes = get_tastes(answers)
    matches = []
    failures_by_status = {"rejected": Counter(), "unknown": Counter()}
    for car in cars:
        failures = check_rules(car, rules)
        if not failures:
            matches.append(rate_car(car, answers, balance, rules, weights, tastes))
        for key, status in failures.items():
            failures_by_status[status][key] += 1

    if not matches:
        result["status"] = "no_matches"
        result["message"] = "В каталоге пока нет автомобилей, которые подтверждённо выполняют все условия."
        for question, key, label, _ in rules:
            rejected = failures_by_status["rejected"][key]
            unknown = failures_by_status["unknown"][key]
            if rejected or unknown:
                result["filterDetails"].append({
                    "question": question, "label": label, "rejected": rejected, "unknown": unknown,
                })
                result["filters"].append(
                    f"{label} — не подходят {rejected}, недостаточно данных для {unknown}."
                )
        result["compromises"] = get_compromise_options(cars, answers)
        return result

    result["status"] = "matches"
    result["message"] = ""
    result["count"] = len(matches)
    # В сравнении участвуют предварительные экспертные ориентиры, если в каталоге
    # нет проверенного испытания для конкретной комплектации. Не скрываем этого.
    if "safety" in answers.get("10", []):
        if all(car["safety"] is None and car["reliability"] is None for car in matches):
            result["notes"].append("Безопасность и надёжность пока не подтверждены по этим моделям.")
        elif any(car.get("rating_provenance", {}).get("safety") == "estimated" for car in matches):
            result["notes"].append("Баллы безопасности и надёжности пока предварительные, не официальные результаты испытаний.")
    if not tastes:
        result["notes"].append("Чтобы увидеть выбор сердцем, отметь понравившиеся варианты в визуальных вопросах.")
    elif not any(car["heart"] is not None for car in matches):
        result["notes"].append("Для выбранных визуальных предпочтений пока нет оценок в каталоге.")

    # Первыми идут высокие оценки
    ordered = sorted(matches, key=lambda car: (
        car["total_adjusted"] is None, -(car["total_adjusted"] or 0), car["id"],
    ))
    for car in ordered:
        alternatives = [other for other in ordered[:3] if other["id"] != car["id"]]
        car["alternatives"] = [
            {key: other[key] for key in ("id", "brand", "model", "trim")}
            for other in alternatives[:2]
        ]
    rankings = {"balance": ordered}
    for key in ("reason", "heart"):
        score = "reason_adjusted" if key == "reason" else "heart_adjusted"
        rankings[key] = sorted((car for car in matches if car[key] is not None),
                               key=lambda car: (-car[score], car["id"]))
    # Для трёх карточек достаточно первых трёх разных моделей каждой категории.
    choices = []
    for key in ("reason", "balance", "heart"):
        result[key] = rankings[key][:5]
        models = {}
        for rank, car in enumerate(rankings[key]):
            model = (car["brand"].casefold(), car["model"].casefold())
            models.setdefault(model, (key, model, rank, car))
            if len(models) == 3:
                break
        choices.append([*models.values(), None])
    best = []
    for group in product(*choices):
        picks = [item for item in group if item]
        if len({item[1] for item in picks}) != len(picks):
            continue
        if (-len(picks), sum(p[2] for p in picks)) < (-len(best), sum(p[2] for p in best)):
            best = picks
    result["picks"] = [{"type": key, "car": car} for key, _, _, car in best]
    return result


def get_compromise_options(cars, answers):
    """Ищет изменения одного обязательного условия, расширяющие выдачу."""
    suggestions = []
    option_keys = {"transmission": "automatic", "drive": "awd", "boot_l": "boot", "fuel_type": "engine"}
    rules = get_rules(answers)
    for _, key, label, _ in rules:
        candidate = dict(answers)
        others = [rule for rule in rules if rule[1] != key]
        possible = [car[key] for car in cars if car[key] is not None and not check_rules(car, others)]
        if key == "price_rub" and possible:
            price = min(possible)
            candidate.update({"1": "custom", "budgetMax": price})
            description = f"Увеличить бюджет до {price:,} ₽".replace(",", " ")
        elif key == "seats" and possible and max(possible) >= 2:
            seats = max(possible)
            candidate.pop("minSeats", None)
            if seats >= 6:
                candidate.update({"5": "six", "minSeats": seats})
            else:
                candidate["5"] = max((k for k, n in seat_options.items() if n <= seats), key=seat_options.get)
                seats = seat_options[candidate["5"]]
            description = f"Снизить минимум мест до {seats}"
        elif key == "condition":
            candidate["2"] = "both"
            description = "Рассматривать и новые автомобили, и машины с пробегом"
        elif key == "hybrid_type":
            candidate["hybrid"] = "any"
            description = "Рассмотреть любой подтип гибрида"
        elif key in option_keys:
            if key == "fuel_type" and candidate.get("hybrid") in allowed_values["hybrid_type"]:
                continue  # Подтип остаётся самостоятельным ограничением.
            candidate["7"] = [v for v in answers["7"] if v != option_keys[key]]
            if key == "fuel_type":
                candidate.pop("engine", None)
                candidate.pop("hybrid", None)
            description = f"Снять условие «{label}»"
        else:
            continue
        candidate_rules = get_rules(candidate)
        count = sum(not check_rules(car, candidate_rules) for car in cars)
        if count:
            suggestions.append({"description": description, "count": count, "answers": candidate})
    return suggestions


# Профиль строится только по личным предпочтениям, без базовых весов.
def build_user_dna(answers):
    """Рассчитывает доли приоритетов пользователя без выдуманных процентов."""
    groups = {
        "practical": ("Практичность", {"safety", "reliability", "city", "gravel", "offroad", "family", "daily_use", "cargo", "capacity", "size"}),
        "comfort": ("Комфорт", {"comfort", "highway", "cozy_interior"}),
        "economy": ("Экономичность", {"economy", "maintenance"}),
        "dynamics": ("Динамика", {"dynamics", "driving_fun", "engine_power_hp"}),
        "style": ("Стиль", set(labels) - {"cozy_interior"}),
    }
    weights = get_weights(answers)
    personal = {key: max(0, value - base_weights.get(key, 0)) for key, value in weights.items()}
    personal.update(get_tastes(answers))
    values = dict.fromkeys(groups, 0)
    for key, weight in personal.items():
        for group, (_, members) in groups.items():
            if key in members:
                values[group] += weight
                break
    total = sum(values.values())
    raw = {key: value / total * 100 if total else 0 for key, value in values.items()}
    percents = {key: int(value) for key, value in raw.items()}
    if total:
        for key in sorted(raw, key=lambda key: -(raw[key] - percents[key]))[:100 - sum(percents.values())]:
            percents[key] += 1
    traits = [{"key": key, "label": groups[key][0], "percent": percents[key]} for key in groups]
    answered = sum(bool(answers.get(key)) for key in ("3", "4", "6", "8", "9", "10", *duels))
    primary = max(traits, key=lambda item: item["percent"])["label"] if total else None
    return {"traits": traits, "primary": primary, "status": "ready" if answered >= 4 and total else "preliminary",
            "description": "Доли отражают выбранные предпочтения, а не вероятность удачной покупки." if total else "Ответь на вопросы о своих предпочтениях, чтобы сформировать профиль."}


# Подбираем противоположные стили, стараясь не повторять машины между дуэлями.
# Вопрос 13 — фотографии настоящих интерьеров, они не относятся к выборке кузовов.
def get_dynamic_duels(answers, cars):
    """Подбирает восемь разных автомобилей для вопросов 11, 12, 14 и 15.

    Используем только реальные автомобили с фотографиями и с преимуществом
    соответствующего стилевого признака над противоположным. Сначала выбираем
    ещё не показанные модели, затем — подходящие по жёстким ограничениям,
    марки без повторов и, наконец, лучшие по рациональному профилю.

    Если каталог станет маленьким и для какого-то противоположного стиля не
    останется новых фото, допускаем повтор вместо выдуманной модели. При
    неизменном каталоге и ответах пары воспроизводимы.
    """
    rules = get_rules(answers)
    weights = get_weights(answers)
    pictured = [car for car in cars if car.get("image_url")]
    eligible_ids = {car["id"] for car in pictured if not check_rules(car, rules)}
    result = {}
    shown_ids = set()
    shown_brands = set()

    for question, (first, second) in duels.items():
        if question == "13":
            continue  # Фотографии интерьеров остаются независимыми от кузова.

        pair = {}
        for side, positive, negative in (("a", first, second), ("b", second, first)):
            variants = [car for car in pictured
                        if car[positive] is not None and car[negative] is not None
                        and car[positive] >= 4 and car[positive] > car[negative]]
            if question == "14":
                bodies = {"sedan"} if side == "a" else {"crossover", "suv"}
                variants = [car for car in variants if car["body_type"] in bodies]

            if not variants:
                pair = {}  # Не показываем фальшивый «контраст», если нет примеров.
                break

            # Идентичный автомобиль нельзя показывать ни в одной другой дуэли,
            # пока для соответствующего стиля есть хотя бы один новый вариант.
            # Жёсткие фильтры НЕ применяются к дуэлям: они нужны для выявления
            # вкуса; фильтры неизменно действуют на итоговые рекомендации.
            variants.sort(key=lambda car: (
                car["id"] in shown_ids,
                car["id"] not in eligible_ids,
                car["brand"] in shown_brands,
                -(get_score(practical_values(car, answers), weights)[0] or 0),
                -(car[positive] - car[negative]),
                car["id"],
            ))
            selected = variants[0]
            pair[side] = selected["image_url"]
            shown_ids.add(selected["id"])
            shown_brands.add(selected["brand"])

        if len(pair) == 2 and pair["a"] != pair["b"]:
            result[question] = pair
    return result


# Объясняем конкретную модель теми же правилами, что используются при подборе.
def explain_car_choice(car, answers, cars, balance=50):
    """Объясняет выполнение ограничений и отличия конкретной модели от топа."""
    rules = get_rules(answers)
    failures = check_rules(car, rules)
    ranked = rate_car(car, answers, balance, rules, get_weights(answers), get_tastes(answers))
    results = get_results(cars, answers, balance)
    ordered = sorted((rate_car(item, answers, balance, rules, get_weights(answers), get_tastes(answers))
                      for item in cars if not check_rules(item, rules)),
                     key=lambda item: (item["total_adjusted"] is None, -(item["total_adjusted"] or 0), item["id"]))
    rank = next((i + 1 for i, item in enumerate(ordered) if item["id"] == car["id"]), None)
    selected = any(item["car"]["id"] == car["id"] for item in results["picks"])
    message = "Модель уже входит в твой подбор." if selected else "Для трёх категорий выбраны разные модели с учётом рейтингов практичности и стиля."
    if failures:
        message = "Модель исключена: не все обязательные условия подтверждены."
    elif get_preference_evidence(answers) == 0:
        message = ("Автомобиль выполняет указанные обязательные условия. "
                   "Рейтинг пока предварительный: для персонального выбора нужны ответы о потребностях и дизайне.")
    elif rank:
        message += f" Место в общем рейтинге: {rank} из {len(ordered)}."
        if rank > 1:
            leader = ordered[0]
            message += f" Выше стоит {leader['brand']} {leader['model']}: оценка с учётом полноты данных {leader['total_adjusted']}."
    return {"car": ranked, "status": "excluded" if failures else "recommended" if selected else "lower_rank",
            "conditions": [{"label": label, "status": failures.get(key, "matched")} for _, key, label, _ in rules],
            "rank": rank, "count": len(ordered), "message": message}


# Создаём приложение Flask
