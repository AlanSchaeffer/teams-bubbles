#!/bin/bash
# Cenário de teste. Usa o estado interno da extensão (stateObj) via Eval.
set -u
T=$TB_TESTDIR
OUT=$TB_OUT
FAIL=0

ev() {  # avalia JS no Shell e imprime só o valor (sem aspas externas)
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval "$1" | sed 's/^(true/(True/; s/^(false/(False/' |
    python3 -c "
import sys, ast, json
ok, v = ast.literal_eval(sys.stdin.read())
if not ok:
    print('EVAL_ERROR: ' + v)
else:
    v = json.loads(v) if v else ''
    print(v if isinstance(v, str) else json.dumps(v))"
}
shot() {
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT/$1.png" >/dev/null
}
check() {  # check "descrição" "esperado" "obtido"
  if [ "$2" == "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1"; echo "      esperado: $2"; echo "      obtido:   $3"; FAIL=1; fi
}

X="Main.extensionManager.lookup('$TB_UUID')"
E="$X.stateObj"
ENTRIES="JSON.stringify([...$E._entries.values()].map(x => x.key + '#' + x.count))"

check "extensão carregou (state 1 = ativa)" "1" "$(ev "String($X.state) + ($X.error ? ' ' + $X.error : '')")"
ev "$E._settings.set_string('monitor-connector', ''); 'ok'" >/dev/null

# Fase A: padrões (só Teams; grupos sem menção ocultos; reuniões visíveis)
python3 "$T/send_samples.py" a "$OUT/signals.log" 25 &
sleep 2.5
check "fase A: bolhas" \
  '["fulano de tal#2","teams:reunioes#1","beltrano souza#1"]' "$(ev "$ENTRIES")"
check "fase A: nenhum pop-up de notificação do Teams" "ok" \
  "$(ev "const teams = ['Nice job! Notifications are now on.', 'Fulano de Tal', 'Nome do Grupo', 'Fulano de Tal @mentioned you', 'In 5 min: Daily', 'Beltrano Souza'];
       const shown = [Main.messageTray._notification, ...Main.messageTray._notificationQueue].filter(n => n && teams.includes(n.title));
       shown.length ? shown.map(n => n.title).join(', ') : 'ok'")"
check "fase A: foto copiada (sobrevive ao arquivo temporário)" "true" \
  "$(ev "const x = $E._entries.get('fulano de tal'); String(!!x.avatarPath && GLib.file_test(x.avatarPath, GLib.FileTest.EXISTS))")"
check "tela cheia: inibe o direct scanout enquanto há bolhas" "true" \
  "$(ev "String(!!$E._unredirectInhibited)")"
ev "$E._showTooltip($E._entries.get('fulano de tal')); 'ok'" >/dev/null
sleep 0.4; shot bubbles-tooltip
ev "$E._hideTooltip(); 'ok'" >/dev/null

# Fase B: grupos e outros sites do Chrome ligados
ev "$E._settings.set_boolean('show-group-messages', true); $E._settings.set_boolean('capture-all-chrome', true); 'ok'" >/dev/null
python3 "$T/send_samples.py" b "$OUT/signals.log" 20 &
sleep 1.5
check "fase B: grupo e site viram bolhas" \
  '["fulano de tal#2","teams:reunioes#1","beltrano souza#1","grupo:nome do grupo#1","site:calendar.google.com#1"]' \
  "$(ev "$ENTRIES")"

ev "$E._indicator.menu.open(); 'ok'" >/dev/null
sleep 0.5; shot menu
ev "$E._indicator.menu.close(); 'ok'" >/dev/null

# Monitor
check "troca de monitor move as bolhas" "true" \
  "$(ev "$E._settings.set_string('monitor-connector', $E._monitorList()[1].connector); String($E._stack.x > 1280)")"
sleep 0.4; shot monitor2

# Clique: ativa a notificação (Chrome recebe ActionInvoked 'default'); app trocado por um falso
ev "for (const x of $E._entries.values()) x.app = {activate() {}}; $E._findTeamsApp = () => null; $E._open($E._entries.get('fulano de tal')); 'ok'" >/dev/null
sleep 0.5
check "clique envia ActionInvoked 'default' ao Chrome" "1" \
  "$(grep -q "ActionInvoked.*'default'" "$OUT/signals.log" && echo 1 || echo 0)"
check "clique remove a bolha" "false" "$(ev "String($E._entries.has('fulano de tal'))")"

# Botão direito / descartar e limpar tudo
ev "$E._dismiss($E._entries.get('beltrano souza')); 'ok'" >/dev/null
check "descartar remove a bolha" "false" "$(ev "String($E._entries.has('beltrano souza'))")"
ev "$E._clearAll(); 'ok'" >/dev/null
sleep 0.5
check "limpar lista esvazia e esconde" "0 false" "$(ev "$E._entries.size + ' ' + $E._stack.visible")"

check "tela cheia: libera o direct scanout quando não há bolhas" "false" \
  "$(ev "String(!!$E._unredirectInhibited)")"

# Desativar / reativar
# Estados (GNOME 46+): 1 ACTIVE, 2 INACTIVE, 3 ERROR. Em versões antigas os nomes mudam.
ev "Main.extensionManager.disableExtension('$TB_UUID'); 'ok'" >/dev/null; sleep 1
check "disable sem erro" "2" "$(ev "String($X.state)")"
ev "Main.extensionManager.enableExtension('$TB_UUID'); 'ok'" >/dev/null; sleep 1
check "enable sem erro" "1" "$(ev "String($X.state)")"

if grep -q -E "JS ERROR|CRITICAL.*$TB_UUID" "$OUT/shell.log"; then
  echo "FAIL  erros no log do Shell:"; grep -E -A3 "JS ERROR|CRITICAL.*$TB_UUID" "$OUT/shell.log" | head -20; FAIL=1
fi

wait
echo
[ $FAIL -eq 0 ] && echo "TUDO OK" || echo "HOUVE FALHAS"
exit $FAIL
