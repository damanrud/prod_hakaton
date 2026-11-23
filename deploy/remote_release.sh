#!/bin/sh
# Релиз трёх образов на Linux VM. Не удаляет Docker volume с SQLite.
# Параметры: image_prefix git_commit_sha
set -eu
PREFIX="${1:?Registry image prefix is required}"  # Например registry.gitlab.com/group/autochoice.
TAG="${2:?Git commit tag is required}"         # Полный SHA обеспечивает воспроизводимость.
APP_DIR="${AUTOCHOICE_DEPLOY_DIR:-$HOME/autochoice}"  # Файлы приложения на VM.
cd "$APP_DIR"

# Название compose строго соответствует файлу из CI/CD.
COMPOSE_FILE="docker-compose.prod.yml"
PREVIOUS=""
if [ -f .last_successful_tag ]; then
    PREVIOUS=$(cat .last_successful_tag)
fi

# Запускаем Compose с переменными для трёх images. Без --build на VM.
run_compose() {
    tag="$1"
    shift
    IMAGE_PREFIX="$PREFIX" IMAGE_TAG="$tag" docker compose -f "$COMPOSE_FILE" "$@"
}

# Проверяем Nginx -> React и Nginx -> Flask, затем проверяем реальный каталог.
check_release() {
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
        if curl --fail --silent --show-error --max-time 5 http://127.0.0.1/ | grep -q 'AutoChoice' &&
           curl --fail --silent --show-error --max-time 5 http://127.0.0.1/health | grep -q '"status":"ok"' &&
           curl --fail --silent --show-error --max-time 5 http://127.0.0.1/api/catalog/status | grep -q '"status":"ready"'; then
            return 0
        fi
        sleep 3
    done
    return 1
}

# Не останавливаем рабочие контейнеры, пока не скачаны все новые образы.
run_compose "$TAG" pull
if run_compose "$TAG" up -d --remove-orphans --wait --wait-timeout 120 && check_release; then
    printf '%s\n' "$TAG" > .last_successful_tag
    echo "DEPLOY_OK $TAG"
    exit 0
fi

# После ошибки возвращаем ранее подтверждённую сборку.
echo "DEPLOY_FAILED $TAG" >&2
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$TAG" ]; then
    echo "ROLLBACK_TO $PREVIOUS" >&2
    if run_compose "$PREVIOUS" up -d --remove-orphans --wait --wait-timeout 120 && check_release; then
        echo 'ROLLBACK_OK'
    else
        echo 'ROLLBACK_FAILED — examine docker compose logs on VM' >&2
    fi
else
    echo 'NO_PREVIOUS_RELEASE — first deployment needs manual diagnosis' >&2
fi
exit 1
