#!/usr/bin/env bash
# Create a one-step launcher for a project's model viewer (Linux with a systemd user session;
# uses Omarchy's web-app window when present, else a Chromium app window or the default browser).
#
#   make_launcher.sh NAME SERVE_DIR PORT "Display Name" [ICON]
#
#   NAME        short id, lower case, e.g. "plant": makes the command NAME-view and unit NAME-viewer
#   SERVE_DIR   directory served as the web root; the viewer must be at SERVE_DIR/viewer/
#   PORT        local port, unique per project (served on 127.0.0.1; phone sharing reuses it
#               on the tailnet)
#   optional environment: COMMENT (launcher tooltip), DOC (a Documentation= URL for the unit)
#
# Writes (and reports) five files, and enables the login-time clear unit:
#   ~/.config/systemd/user/NAME-viewer.service          on-demand http.server, stops after 12 h
#   ~/.config/systemd/user/NAME-viewer-awake.service    blocks sleep while shared to a phone
#   ~/.config/systemd/user/NAME-viewer-clear.service    at login, removes a phone mapping left
#                                                       by a crash or power loss
#   ~/.local/bin/NAME-view                              starts the unit if needed, opens the viewer
#   ~/.local/share/applications/<Display Name>.desktop  launcher entry: models, phone, stop
# Refuses to overwrite existing files unless FORCE=1. Record the change in the system log.
set -euo pipefail
[ $# -ge 4 ] || { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
NAME=$1; DIR=$(realpath "$2"); PORT=$3; DISPLAY_NAME=$4; ICON=${5:-org.freecad.FreeCAD}
COMMENT=${COMMENT:-3D models, click to inspect}; DOC=${DOC:-}
[[ $NAME =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "NAME must be lower-case letters, digits, '-'" >&2; exit 2; }
[[ $PORT =~ ^[1-9][0-9]{3,4}$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || { echo "PORT must be 1024-65535" >&2; exit 2; }
[[ -n $DISPLAY_NAME && $DISPLAY_NAME != .* && $DISPLAY_NAME != */* && $DISPLAY_NAME != *\\* && $DISPLAY_NAME != *$'\n'* ]] \
  || { echo "Display Name must be non-empty, not start with '.', and have no / \\ or newlines" >&2; exit 2; }
[[ $DIR != *$'\n'* && $COMMENT != *$'\n'* && $DOC != *[[:space:]]* ]] \
  || { echo "SERVE_DIR and COMMENT cannot contain newlines; DOC cannot contain spaces" >&2; exit 2; }
UNIT=~/.config/systemd/user/${NAME}-viewer.service
AWAKE=~/.config/systemd/user/${NAME}-viewer-awake.service
CLEAR=~/.config/systemd/user/${NAME}-viewer-clear.service
CMD=~/.local/bin/${NAME}-view
DESK=~/.local/share/applications/${DISPLAY_NAME}.desktop
[ -f "$DIR/viewer/index.html" ] || { echo "no viewer at $DIR/viewer/index.html" >&2; exit 1; }
[ -f "$DIR/viewer/models.json" ] || { echo "no $DIR/viewer/models.json (copy models.example.json)" >&2; exit 1; }
for f in "$UNIT" "$AWAKE" "$CLEAR" "$CMD" "$DESK"; do
  if [ -e "$f" ] && [ "${FORCE:-0}" != 1 ]; then echo "exists: $f (FORCE=1 to overwrite)" >&2; exit 1; fi
done
mkdir -p "$(dirname "$UNIT")" "$(dirname "$CMD")" "$(dirname "$DESK")"

# systemd reads % as a specifier: double it in free text and paths.
{
  printf '[Unit]\nDescription=%s (local web server, 127.0.0.1 only)\n' "${DISPLAY_NAME//%/%%}"
  [ -z "$DOC" ] || printf 'Documentation=%s\n' "${DOC//%/%%}"
  cat <<EOF

[Service]
# Started on demand by ${NAME}-view; not enabled at login.
WorkingDirectory=${DIR//%/%%}
# Phone sharing (${NAME}-view phone) maps this server onto the tailnet. Every stop (also the
# 12 h limit and a crash) clears that mapping, and so does every start; a mapping left by a
# power loss is cleared at login by ${NAME}-viewer-clear.service. The leading '-' ignores
# "no mapping" and a missing tailscale.
ExecStartPre=-/usr/bin/env tailscale serve --yes --http=${PORT} off
# Stops on its own after a working day. timeout(1), not RuntimeMaxSec: reaching
# RuntimeMaxSec marks the unit failed, so a planned stop raised a failed-unit alert (and
# revived the server every 12 h under a restart policy). timeout exits 124, declared a
# success below; a crash still fails. No Restart= either way.
ExecStart=/usr/bin/timeout 12h /usr/bin/python3 -m http.server ${PORT} --bind 127.0.0.1
SuccessExitStatus=124
ExecStopPost=-/usr/bin/env tailscale serve --yes --http=${PORT} off
EOF
} > "$UNIT"

cat > "$AWAKE" <<EOF
[Unit]
Description=${DISPLAY_NAME//%/%%}: keep this machine awake while shared to a phone
# Stops whenever the server stops, for any reason (BindsTo; PartOf would miss the 12 h limit
# and crashes, leaving the machine unable to sleep).
BindsTo=${NAME}-viewer.service
After=${NAME}-viewer.service

[Service]
# Its own 12 h backstop: sleep ends and the unit stops cleanly (a RuntimeMaxSec backstop
# would mark it failed).
ExecStart=/usr/bin/systemd-inhibit --what=sleep:idle:handle-lid-switch --who=${NAME}-view "--why=Viewer shared to a phone" --mode=block /usr/bin/sleep 12h
EOF

cat > "$CLEAR" <<EOF
[Unit]
Description=${DISPLAY_NAME//%/%%}: remove a phone-sharing mapping left by a crash or power loss

[Service]
Type=oneshot
ExecStart=-"${CMD//%/%%}" boot-clear

[Install]
WantedBy=default.target
EOF

# The command: a settings header with every value shell-quoted, then a fixed body.
{
  echo '#!/usr/bin/env bash'
  echo "# Open the ${DISPLAY_NAME//$'\n'/ } in its own app window, starting the local server if needed."
  echo "#   ${NAME}-view                  open the first model"
  echo "#   ${NAME}-view <model>          open that model (a key in viewer/models.json)"
  echo "#   ${NAME}-view <name>           open the first model with <name> selected"
  echo "#   ${NAME}-view phone [<model>]  share to your phone over Tailscale; prints a QR code"
  echo "#   ${NAME}-view phone off        stop sharing to the phone (the server keeps running)"
  echo "#   ${NAME}-view stop | status    control the background server (stop also ends sharing)"
  echo 'set -euo pipefail'
  printf 'PORT=%q\nUNIT=%q\nAWAKE=%q\nTITLE=%q\nMODELS_JSON=%q\n' "$PORT" "${NAME}-viewer.service" \
    "${NAME}-viewer-awake.service" "$DISPLAY_NAME" "$DIR/viewer/models.json"
  cat <<'EOF'
BASE="http://127.0.0.1:${PORT}/viewer/"
MODELS=$(python3 -I -c 'import json, sys; print(" ".join(m["key"] for m in json.load(open(sys.argv[1]))["models"]))' "$MODELS_JSON")

say() { echo "$1"; notify-send "$TITLE" "$1" 2>/dev/null || true; }
die() { echo "$1" >&2; notify-send -u critical "$TITLE" "$1" 2>/dev/null || true; exit 1; }
up() { curl -fs -o /dev/null --max-time 1 "$BASE"; }

start_server() {
  up && return
  systemctl --user start "$UNIT"
  for _ in $(seq 50); do up && return; sleep 0.1; done
  die "Server did not start: systemctl --user status $UNIT"
}

hash_for() {  # "" -> first model; a model key -> that model; anything else -> a name to select
  local first=${MODELS%% *}
  if [ -z "${1:-}" ]; then echo "$first"
  elif [[ " $MODELS " == *" $1 "* ]]; then echo "$1"
  else echo "$first/$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1")"
  fi
}

phone_paths() {
  # Only the viewer folder and the model FILES it loads go on the tailnet; everything else in
  # the served folder (sources, working files) stays private to this machine. A url that is a
  # folder, the root, outside the folder, or reached through a symlink out of it is refused.
  python3 -I - "$MODELS_JSON" <<'PY'
import json, os, posixpath, re, sys
root = os.path.realpath(os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[1]))))
if os.path.realpath(os.path.join(root, "viewer")) != os.path.join(root, "viewer"):
    sys.exit("the viewer folder is a symlink out of the served folder")
print("viewer")
for m in json.load(open(sys.argv[1]))["models"]:
    url = m["url"]
    p = posixpath.normpath(posixpath.join("viewer", url))
    real = os.path.realpath(os.path.join(root, p))
    if (not re.fullmatch(r"[A-Za-z0-9._/-]+", url) or p in (".", "viewer") or p.startswith("../")
            or not os.path.isfile(real) or not real.startswith(root + os.sep)):
        sys.exit(f"model url cannot be shared: {url}")
    if not p.startswith("viewer/"):
        print(p)
PY
}

phone_unmap() { command -v tailscale >/dev/null && tailscale serve --yes --http="$PORT" off >/dev/null 2>&1 || true; }

phone_mapped() {  # true when this port has a tailnet mapping, whatever started it
  command -v tailscale >/dev/null && tailscale serve status --json 2>/dev/null | python3 -I -c 'import json, sys
port = sys.argv[1]
d = json.load(sys.stdin)
sys.exit(0 if any(k.endswith(":" + port) for k in (d.get("Web") or {})) or port in (d.get("TCP") or {}) else 1)' "$PORT"
}

phone_on() {
  command -v tailscale >/dev/null || die "Phone sharing needs Tailscale on this machine."
  local host paths err url
  host=$(tailscale status --json 2>/dev/null | python3 -I -c 'import json, sys
s = json.load(sys.stdin)
print(s["Self"]["DNSName"].rstrip(".") if s.get("BackendState") == "Running" else "")' || true)
  [ -n "$host" ] || die "Tailscale is not connected on this machine. Run: tailscale up"
  paths=$(phone_paths) || die "Cannot share: a model in models.json is not a file inside the served folder."
  mapfile -t paths <<< "$paths"
  start_server
  err=$(mktemp); trap 'rm -f "$err"' EXIT
  # --http: tailnet only (WireGuard-encrypted). Never 'tailscale funnel', which is the public internet.
  # Any failure removes what was already mapped: sharing is all or nothing.
  for p in "${paths[@]}"; do
    tailscale serve --bg --http="$PORT" --set-path="/$p" "http://127.0.0.1:$PORT/$p" >/dev/null 2>"$err" \
      || { phone_unmap; die "tailscale serve failed: $(tail -1 "$err"). If it asks for permission, run once: sudo tailscale set --operator=$USER"; }
  done
  systemctl --user start "$AWAKE" || { phone_unmap; die "Could not start the keep-awake unit; sharing cancelled."; }
  url="http://$host:$PORT/viewer/#$(hash_for "${1:-}")"
  echo "Shared to your Tailscale devices until '${0##*/} phone off', '${0##*/} stop' or the 12 h limit."
  echo "This machine will not sleep, even with the lid closed, while shared."
  echo "On the phone (Tailscale app connected), open: $url"
  if command -v qrencode >/dev/null; then
    if [ -t 1 ]; then qrencode -t ansiutf8 "$url"
    elif [ -n "${XDG_RUNTIME_DIR:-}" ]; then  # private per-user folder; never a guessable /tmp name
      local png
      png=$(mktemp -p "$XDG_RUNTIME_DIR" --suffix=.png phone-qr.XXXXXX)
      qrencode -s 10 -o "$png" "$url" && { setsid xdg-open "$png" >/dev/null 2>&1 & }
    fi
  fi
  notify-send "$TITLE" "Shared to your phone: $url" 2>/dev/null || true
}

phone_off() {
  phone_unmap
  systemctl --user stop "$AWAKE"
  say "Phone sharing is off."
}

case "${1:-}" in
  stop) exec systemctl --user stop "$UNIT" ;;
  status)
    systemctl --user status "$UNIT" --no-pager || true
    if phone_mapped; then echo "Phone sharing: ON"; tailscale serve status 2>/dev/null || true
    else echo "Phone sharing: off"; fi
    if systemctl --user is-active -q "$AWAKE"; then echo "Keep-awake: ON (this machine will not sleep)"; fi
    exit 0 ;;
  boot-clear)  # run at login by the clear unit; waits up to 2 min for tailscaled
    command -v tailscale >/dev/null || exit 0
    for _ in $(seq 60); do tailscale status >/dev/null 2>&1 && break; sleep 2; done
    systemctl --user is-active -q "$UNIT" || phone_unmap
    exit 0 ;;
  -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  phone)
    case "${2:-}" in
      off) phone_off ;;
      -*) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' ;;  # an option is never a model to share
      *) phone_on "${2:-}" ;;
    esac
    exit 0 ;;
esac

start_server
URL="${BASE}#$(hash_for "${1:-}")"
# Omarchy opens it as a web-app window; elsewhere use a Chromium app window or the default browser.
if command -v omarchy-launch-webapp >/dev/null; then exec omarchy-launch-webapp "$URL"; fi
for b in chromium chromium-browser google-chrome-stable google-chrome brave; do
  command -v "$b" >/dev/null && exec setsid "$b" --app="$URL" >/dev/null 2>&1
done
exec xdg-open "$URL"
EOF
} > "$CMD"
chmod +x "$CMD"

# Desktop entries: absolute Exec (a new ~/.local/bin may not be on the session PATH until the
# next login), quoted per the Desktop Entry spec (backslash, quote, backtick, dollar escaped).
dq() { printf '%s' "$1" | sed 's/[\\"`$]/\\\\&/g; s/%/%%/g'; }  # Exec quoting, then % field codes
exec_path=$(dq "$CMD")
# One "Open <label>" action per model after the first (the main entry opens the first).
mapfile -t models < <(python3 -I -c 'import json, sys
for m in json.load(open(sys.argv[1]))["models"][1:]:
    if not any(c in m["key"] + m["label"] for c in "\n\r\t"):
        print(m["key"] + "\t" + m["label"])' "$DIR/viewer/models.json")
{
  printf '[Desktop Entry]\nVersion=1.0\nName=%s\nComment=%s\n' "$DISPLAY_NAME" "$COMMENT"
  printf 'Exec="%s"\nTerminal=false\nType=Application\nIcon=%s\nStartupNotify=true\n' "$exec_path" "$ICON"
  printf 'Actions='; for i in "${!models[@]}"; do printf 'model%d;' "$i"; done; printf 'phone;phoneoff;stop;\n'
  for i in "${!models[@]}"; do
    printf '\n[Desktop Action model%d]\nName=Open %s\nExec="%s" "%s"\n' "$i" "${models[i]#*$'\t'}" "$exec_path" "$(dq "${models[i]%%$'\t'*}")"
  done
  printf '\n[Desktop Action phone]\nName=Share to phone (Tailscale)\nExec="%s" phone\n' "$exec_path"
  printf '\n[Desktop Action phoneoff]\nName=Stop sharing to phone\nExec="%s" phone off\n' "$exec_path"
  printf '\n[Desktop Action stop]\nName=Stop the viewer server\nExec="%s" stop\n' "$exec_path"
} > "$DESK"

systemctl --user daemon-reload
systemctl --user enable "${NAME}-viewer-clear.service" >/dev/null 2>&1 || echo "note: could not enable ${NAME}-viewer-clear.service" >&2
systemd-analyze --user verify "$UNIT" "$AWAKE" "$CLEAR"
bash -n "$CMD"
if command -v desktop-file-validate >/dev/null; then desktop-file-validate "$DESK"; fi
echo "wrote: $UNIT"
echo "wrote: $AWAKE"
echo "wrote: $CLEAR (enabled at login)"
echo "wrote: $CMD"
echo "wrote: $DESK"
