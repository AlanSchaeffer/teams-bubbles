#!/bin/bash
# Roda DENTRO do dbus-run-session criado por run-headless.sh.
set -u
T=$TB_TESTDIR
# Trava de segurança: sem isolamento, gsettings abaixo alteraria a sessão real.
case "${XDG_CONFIG_HOME:-}" in
  "$TB_WORK"/*) ;;
  *) echo "ERRO: ambiente não isolado (XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-})"; exit 1;;
esac

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell disable-extension-version-validation true
gsettings set org.gnome.shell enabled-extensions "['tb-test-helper@local', '$TB_UUID']"

gnome-shell --headless --wayland --no-x11 --wayland-display="tb-test-$$" \
  --virtual-monitor 1280x720 --virtual-monitor 1280x720 > "$TB_OUT/shell.log" 2>&1 &
SHELL_PID=$!
for _ in $(seq 1 60); do
  gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell >/dev/null 2>&1 && break
  sleep 0.5
done
sleep 3

bash "$T/scenario.sh"
RC=$?
kill $SHELL_PID 2>/dev/null; wait $SHELL_PID 2>/dev/null
exit $RC
