#!/bin/bash
# Instala/atualiza a extensão Teams Bubbles. Depois: sair e entrar na sessão.
set -e
V=$(gnome-shell --version 2>/dev/null | grep -o '[0-9]\+' | head -1)
if [ "$V" != "50" ]; then
  echo "Aviso: feito e testado para GNOME Shell 50 (Ubuntu 26.04). Detectado: ${V:-nenhum}."
  echo "Em outra versão o GNOME não vai carregar a extensão."
fi
UUID=teams-bubbles@alanschaeffer.github.io
SRC=$(cd "$(dirname "$0")" && pwd)
DEST=$HOME/.local/share/gnome-shell/extensions/$UUID
rm -rf "$DEST"; mkdir -p "$DEST"
cp -r "$SRC"/metadata.json "$SRC"/extension.js "$SRC"/stylesheet.css "$SRC"/icons "$SRC"/schemas "$DEST"/
glib-compile-schemas "$DEST/schemas"
python3 - "$UUID" <<'PY'
import sys, subprocess, ast
uuid = sys.argv[1]
cur = ast.literal_eval(subprocess.check_output(['gsettings','get','org.gnome.shell','enabled-extensions'], text=True).replace('@as ',''))
if uuid not in cur:
    cur.append(uuid)
    subprocess.check_call(['gsettings','set','org.gnome.shell','enabled-extensions', str(cur)])
PY
echo "Instalado em $DEST — saia e entre na sessão para carregar."
