#!/bin/bash
# Remove a extensão Teams Bubbles. Depois: sair e entrar na sessão.
UUID=teams-bubbles@alanschaeffer.github.io
python3 - "$UUID" <<'PY'
import sys, subprocess, ast
uuid = sys.argv[1]
cur = ast.literal_eval(subprocess.check_output(['gsettings','get','org.gnome.shell','enabled-extensions'], text=True).replace('@as ',''))
if uuid in cur:
    cur.remove(uuid)
    subprocess.check_call(['gsettings','set','org.gnome.shell','enabled-extensions', str(cur)])
PY
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID" "$HOME/.cache/teams-bubbles"
echo "Removida — saia e entre na sessão para concluir."
