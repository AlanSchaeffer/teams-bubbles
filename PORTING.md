# Portar para outras versões do GNOME

A extensão foi escrita e testada só no **GNOME Shell 50 (Ubuntu 26.04)**.
Este guia é para quem quiser portar para outra versão, à mão ou pedindo a um
assistente de código (ex.: Claude Code) na própria máquina. Se for usar um
assistente, peça para ele ler este arquivo primeiro.

| Ubuntu    | GNOME | Esforço esperado                                          |
|-----------|-------|-----------------------------------------------------------|
| 25.10     | 49    | Mínimo: provavelmente só `shell-version`                  |
| 25.04     | 48    | Pequeno                                                   |
| 24.04 LTS | 46    | Moderado (componentes visuais e menu)                     |
| 22.04 LTS | 42    | Grande: formato de módulos antigo + API de notificações   |

## 1. Teste antes e depois

```
tests/run-headless.sh
```

Sobe um GNOME Shell **sem tela**, isolado da sua sessão, carrega a extensão,
envia notificações no mesmo formato que o Chrome usa e confere o resultado
(PASS/FAIL). Capturas de tela e o log do Shell ficam em `tests/out/`.

- `tests/send_samples.py`: as notificações simuladas (Teams, grupo, menção,
  reunião, outro site).
- `tests/scenario.sh`: as verificações. Elas acessam o estado interno da
  extensão (`_entries`, `_open`, `_dismiss`...), então ajuste junto se renomear.
- `tests/helper/`: extensão de teste que liga o "modo inseguro" do Shell, para
  o script poder usar `org.gnome.Shell.Eval` e tirar capturas. **Nunca instale
  na sessão real.**

**Cuidado com o isolamento.** As variáveis `XDG_*` precisam estar no ambiente
**antes** do `dbus-run-session`. O dconf é iniciado pelo barramento e herda o
ambiente dele; se elas forem exportadas depois, o `gsettings` do teste grava
nas configurações **reais** (por exemplo, troca a lista de extensões ativas da
sua sessão). `tests/session.sh` tem uma trava para isso; não a remova.

Em versões antigas, verifique se o `gnome-shell` aceita `--headless`,
`--virtual-monitor` e `--wayland-display` (`gnome-shell --help-all`). Sem
eles, use o modo aninhado: `--nested` em versões antigas, `--devkit` nas
novas (precisa do pacote `mutter-dev-bin`).

## 2. Leia o código do Shell instalado

Quase tudo depende de APIs internas do GNOME Shell, que mudam entre versões.
Em vez de confiar em documentação, extraia o JavaScript do próprio Shell:

```
find /usr/lib -name 'libshell-*.so'
gresource list <caminho>/libshell-NN.so | grep -E 'messageTray|notificationDaemon|layout|popupMenu|panelMenu'
gresource extract <caminho>/libshell-NN.so /org/gnome/shell/ui/messageTray.js > messageTray.js
```

Os mais importantes: `ui/notificationDaemon.js` (como a notificação do Chrome
chega pela D-Bus), `ui/messageTray.js` (classes `Source` e `Notification`,
lógica do pop-up) e `ui/layout.js` (`addChrome`).

## 3. Pontos que dependem da versão

Os nomes abaixo são de `extension.js`.

1. **`metadata.json` → `shell-version`.** Lista as versões aceitas. O GNOME
   não carrega a extensão fora dela.

2. **Formato de módulo (GNOME 45+ vs. ≤ 44).** O código usa módulos ES
   (`import ... from 'gi://...'`, `resource:///org/gnome/shell/...`,
   `export default class extends Extension`). Até o GNOME 44 o formato é o
   antigo (`imports.gi`, `imports.ui.main`, `ExtensionUtils.getSettings()`,
   funções `init/enable/disable`). Portar para 22.04 exige reescrever o
   cabeçalho e o ponto de entrada; a lógica pode ser mantida.

3. **Notificações (parte mais sensível).** A extensão:
   - escuta `Main.messageTray` (`source-added`, `source-removed`,
     `getSources()`) e, em cada fonte, o sinal `notification-added`;
   - lê `notification.title`, `.body`, `.gicon`;
   - esconde o pop-up com `notification.urgency = Urgency.LOW` e
     `notification.acknowledged = true` dentro de `notification-added`
     (o Shell 50 emite esse sinal **antes** de decidir mostrar o pop-up);
   - detecta notificação substituída por `notify::body`;
   - ao clicar, chama `notification.activate()`, que faz o Shell mandar
     `ActionInvoked(id, 'default')` ao Chrome, que abre a conversa.

   O GNOME 46 reescreveu essa parte (a notificação virou um GObject com
   propriedades). Antes disso a API era outra (por exemplo, urgência por
   método em vez de propriedade, e atualização por outro sinal). **Confirme no
   `messageTray.js` da versão alvo** a ordem dos sinais e como bloquear o
   pop-up (`_onNotificationRequestBanner` ou equivalente).

4. **Lista vertical de bolhas.** `St.BoxLayout` usa
   `orientation: Clutter.Orientation.VERTICAL`. Versões anteriores usam
   `vertical: true`.

5. **`Main.layoutManager.addChrome(actor, params)`.** No GNOME 50,
   `affectsInputRegion` não existe (dá erro "Unrecognized parameter"). Em
   versões antigas, principalmente em sessão **X11**, ele existe e define se
   o clique chega às bolhas. Se os cliques "atravessarem" as bolhas, é aqui.

6. **Monitores.** `_monitorList()` usa
   `global.backend.get_monitor_manager()`, `get_logical_monitors()`,
   `LogicalMonitor.get_number()` e `Monitor.get_connector()` /
   `get_display_name()`. Em versões antigas o gerenciador pode ser
   `Meta.MonitorManager.get()`.

7. **Menu.** `PopupMenu.Ornament.CHECK` pode não existir em versões antigas
   (use `DOT`). `PopupSwitchMenuItem`, `PopupSubMenuMenuItem` e
   `PanelMenu.Button` existem há muito tempo.

8. **`connectObject` / `disconnectObject`.** Existem desde o GNOME 42.

9. **Estados de extensão no teste.** `tests/scenario.sh` espera os números do
   GNOME 46+ (1 ativa, 2 inativa). Em versões antigas os valores mudam;
   confira em `misc/extensionUtils.js` ou `extensions/extension.js`.

## 4. O que não depende da versão

- **Como reconhecer o Teams.** O Chrome coloca a origem do site na primeira
  linha do corpo da notificação (`teams.cloud.microsoft`,
  `calendar.google.com`...). É por ela que a extensão decide; o "app" da fonte
  não é confiável, porque o Chrome usa o mesmo processo para todos os sites.
- **Formatos do Teams** (notificações em inglês):

  | Tipo             | Título                         | Corpo (após a origem)  |
  |------------------|--------------------------------|------------------------|
  | Direta           | `Fulano de Tal`                | `mensagem`             |
  | Grupo            | `Nome do Grupo`                | `Fulano: mensagem`     |
  | Menção em grupo  | `Fulano de Tal @mentioned you` | `mensagem`             |
  | Reunião          | `In 5 min: Título da reunião`  | ...                    |
  | Ativação         | `Nice job! Notifications are now on.` | ...             |

  O Chrome manda todas como urgência **crítica**, que o GNOME mostra mesmo com
  pop-ups desligados. Por isso a extensão rebaixa a urgência.

- Para ver as notificações reais que chegam (com o Teams configurado em
  "Show in activity and banner"):

  ```
  dbus-monitor --session "type='method_call',interface='org.freedesktop.Notifications',member='Notify'"
  ```

  A saída contém o texto das mensagens; não a compartilhe.
