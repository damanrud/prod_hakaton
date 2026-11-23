#!/bin/sh
set -eu
tag=$1
state="$HOME/autochoice5/current"
project=autochoice5
docker_cmd() { if [ "$use_sudo" = yes ]; then sudo -n docker "$@"; else docker "$@"; fi; }
use_sudo=no
docker info >/dev/null 2>&1 || use_sudo=yes
docker_cmd info >/dev/null
for service in backend frontend nginx; do
    docker_cmd build -t "autochoice-local/$service:$tag" "$service"
done
compose() {
    version=$1
    shift
    docker_cmd compose --project-name "$project" --env-file "$HOME/autochoice5/releases/$version/release.env" -f "$HOME/autochoice5/releases/$version/deploy/docker-compose.prod.yml" "$@"
}
printf 'IMAGE_PREFIX=autochoice-local\nIMAGE_TAG=%s\nAPP_PORT=80\n' "$tag" > release.env
previous=''
[ ! -f "$state" ] || previous=$(cat "$state")
legacy=''
for id in $(docker_cmd ps -q); do
    docker_cmd port "$id" | grep -q ':80$' || continue
    owner=$(docker_cmd inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$id")
    service=$(docker_cmd inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$id")
    case "$owner/$service" in
        autochoice5/nginx) ;;
        app/app|app/nginx|autochoice/nginx) legacy="$id" ;;
        *) echo "Порт 80 занят контейнером $id проекта $owner. Проверьте владельца."; exit 1 ;;
    esac
done
[ -z "$legacy" ] || docker_cmd stop "$legacy"
if compose "$tag" up -d --wait --wait-timeout 150 && curl -fsS http://localhost/health && curl -fsS http://localhost/api/catalog/status | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"' && curl -fsS http://localhost/ | grep -q AutoChoice; then
    printf '%s\n' "$tag" > "$state.tmp"
    mv "$state.tmp" "$state"
else
    compose "$tag" logs --tail=30 || true
    if [ -n "$previous" ]; then compose "$previous" up -d --wait; else compose "$tag" down; fi
    [ -z "$legacy" ] || docker_cmd start "$legacy"
    exit 1
fi
