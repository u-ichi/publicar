#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${PUBLICAR_DEV_RUNTIME_DIR:-$ROOT_DIR/tmp/dev-runtime}"
PID_FILE="$RUNTIME_DIR/wrangler-dev.pid"
LOG_FILE="$RUNTIME_DIR/wrangler-dev.log"
HEALTH_BODY_FILE="$RUNTIME_DIR/health.json"
HOST="${PUBLICAR_DEV_HOST:-127.0.0.1}"
PORT="${PUBLICAR_DEV_PORT:-8787}"
HEALTH_URL="${PUBLICAR_DEV_HEALTH_URL:-http://$HOST:$PORT/health}"
WAIT_SECONDS="${PUBLICAR_DEV_WAIT_SECONDS:-30}"
CURL_MAX_TIME="${PUBLICAR_DEV_CURL_MAX_TIME:-3}"

cmd="${1:-start}"

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

print_usage() {
  cat <<'USAGE'
Usage: scripts/dev-runtime.sh [start|foreground|stop|restart|status|health|logs]

start   Start wrangler dev in the background and wait for /health.
foreground Start wrangler dev in the foreground.
stop    Stop the background wrangler dev process.
restart Stop then start.
status  Print process and health status.
health  Request the local /health endpoint.
logs    Print the recent dev runtime log.
USAGE
}

start_runtime() {
  mkdir -p "$RUNTIME_DIR"
  export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-$RUNTIME_DIR/wrangler-debug.log}"
  export WRANGLER_REGISTRY_PATH="${WRANGLER_REGISTRY_PATH:-$RUNTIME_DIR/wrangler-registry}"
  export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$RUNTIME_DIR/cache}"

  if is_running; then
    echo "dev runtime already running: pid=$(cat "$PID_FILE")"
    curl -fsS --max-time "$CURL_MAX_TIME" "$HEALTH_URL"
    echo
    return 0
  fi

  cd "$ROOT_DIR"
  : >"$LOG_FILE"
  echo "starting dev runtime: $HEALTH_URL"
  nohup npm run dev -- --ip "$HOST" --port "$PORT" >"$LOG_FILE" 2>&1 &
  echo "$!" >"$PID_FILE"

  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    if curl -fsS --max-time "$CURL_MAX_TIME" "$HEALTH_URL" >"$HEALTH_BODY_FILE" 2>/dev/null; then
      cat "$HEALTH_BODY_FILE"
      rm -f "$HEALTH_BODY_FILE"
      echo
      echo "dev runtime ready: pid=$(cat "$PID_FILE")"
      return 0
    fi
    if ! is_running; then
      echo "dev runtime exited while starting"
      tail -n 80 "$LOG_FILE" || true
      return 1
    fi
    sleep 1
  done

  rm -f "$HEALTH_BODY_FILE"
  echo "dev runtime did not become healthy within ${WAIT_SECONDS}s"
  tail -n 80 "$LOG_FILE" || true
  return 1
}

foreground_runtime() {
  mkdir -p "$RUNTIME_DIR"
  export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-$RUNTIME_DIR/wrangler-debug.log}"
  export WRANGLER_REGISTRY_PATH="${WRANGLER_REGISTRY_PATH:-$RUNTIME_DIR/wrangler-registry}"
  export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$RUNTIME_DIR/cache}"
  cd "$ROOT_DIR"
  exec npm run dev -- --ip "$HOST" --port "$PORT"
}

stop_runtime() {
  if ! is_running; then
    echo "dev runtime is not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  echo "stopping dev runtime: pid=$pid"
  kill "$pid" 2>/dev/null || true
  local i
  for ((i = 0; i < 10; i++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "dev runtime stopped"
      return 0
    fi
    sleep 1
  done
  kill -TERM "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
}

case "$cmd" in
  start)
    start_runtime
    ;;
  foreground)
    foreground_runtime
    ;;
  stop)
    stop_runtime
    ;;
  restart)
    stop_runtime
    start_runtime
    ;;
  status)
    if is_running; then
      echo "dev runtime running: pid=$(cat "$PID_FILE")"
      curl -fsS --max-time "$CURL_MAX_TIME" "$HEALTH_URL"
      echo
    else
      echo "dev runtime stopped"
      exit 1
    fi
    ;;
  health)
    curl -fsS --max-time "$CURL_MAX_TIME" "$HEALTH_URL"
    echo
    ;;
  logs)
    tail -n "${PUBLICAR_DEV_LOG_LINES:-120}" "$LOG_FILE"
    ;;
  -h|--help|help)
    print_usage
    ;;
  *)
    print_usage >&2
    exit 2
    ;;
esac
