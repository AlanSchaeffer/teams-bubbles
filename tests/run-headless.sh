#!/bin/bash
# Testa a extensão num GNOME Shell headless (sem tela), totalmente isolado da
# sessão real: configurações, extensões e caches ficam num diretório temporário.
#
# Uso: tests/run-headless.sh
# Saída: PASS/FAIL no terminal; capturas e log do Shell em tests/out/
set -eo pipefail
TESTDIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$TESTDIR")
UUID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['uuid'])" "$REPO/metadata.json")
OUT=$TESTDIR/out
WORK=$(mktemp -d "${TMPDIR:-/tmp}/tb-test.XXXXXX")
cleanup() {
  # O portal de documentos monta um FUSE em rt/doc; desmonta antes de apagar.
  fusermount3 -u -z "$WORK/rt/doc" 2>/dev/null || fusermount -u -z "$WORK/rt/doc" 2>/dev/null || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
rm -rf "$OUT"; mkdir -p "$OUT"
mkdir -p "$WORK"/{data,config,cache,rt}; chmod 700 "$WORK/rt"

EXT=$WORK/data/gnome-shell/extensions
mkdir -p "$EXT/$UUID" "$EXT/tb-test-helper@local"
cp -r "$REPO"/metadata.json "$REPO"/extension.js "$REPO"/stylesheet.css "$REPO"/icons "$REPO"/schemas "$EXT/$UUID/"
glib-compile-schemas "$EXT/$UUID/schemas"
cp "$TESTDIR/helper/extension.js" "$EXT/tb-test-helper@local/"
SHELL_MAJOR=$(gnome-shell --version | grep -o '[0-9]\+' | head -1)
printf '{"uuid":"tb-test-helper@local","name":"tb test helper","description":"test only","shell-version":["%s"]}\n' \
  "$SHELL_MAJOR" > "$EXT/tb-test-helper@local/metadata.json"

# IMPORTANTE: as variáveis têm de estar no ambiente ANTES do dbus-run-session.
# O dconf é iniciado pelo barramento e herda o ambiente dele; exportar depois
# faz o gsettings gravar nas configurações REAIS do usuário.
env XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" \
    XDG_CACHE_HOME="$WORK/cache" XDG_RUNTIME_DIR="$WORK/rt" \
    TB_WORK="$WORK" TB_UUID="$UUID" TB_OUT="$OUT" TB_TESTDIR="$TESTDIR" \
    timeout 180 dbus-run-session -- bash "$TESTDIR/session.sh" 2>/dev/null |
    grep -E '^(PASS|FAIL|      |TUDO|HOUVE|ERRO)'
