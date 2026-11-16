// Teams Bubbles — bolhas flutuantes para mensagens diretas / @menções do Teams (PWA).
//
// Como funciona: o Chrome entrega as notificações do Teams ao GNOME Shell pelo
// D-Bus. Esta extensão observa a bandeja de mensagens do Shell, pega as que vêm
// do Teams e desenha uma bolha por remetente no canto direito do monitor
// escolhido, acima de todas as janelas (inclusive em tela cheia).
//
// Clique esquerdo: abre a conversa no Teams (ativa a notificação original) e
//                  remove a bolha.
// Clique direito / do meio: descarta a bolha sem abrir.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const TEAMS_HOST_RE = /teams\.(microsoft\.com|live\.com|cloud\.microsoft)/i;
const HOSTNAME_LINE_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i;
const NAME_SUFFIX_RE = new RegExp(
    '\\s+(mentioned you|mencionou( a)? você|mencionou-o|mencionou-a|' +
    'replied|respondeu|sent (you )?a message|enviou( uma)? mensagem|' +
    'reacted|reagiu)(?=$|[\\s:,.!]).*$', 'i');
// Formatos observados (Teams web, notificações em inglês):
//   direta:          título "Fulano de Tal"             corpo "mensagem"
//   grupo:           título "Nome do Grupo"             corpo "Fulano: mensagem"
//   menção em grupo: título "Fulano de Tal @mentioned you" corpo "mensagem"
const MENTION_RE = /\s+@?(mentioned|mencionou)(\s.*)?$/i;
const SYSTEM_TITLE_RE = /notifications are now on|notificações (est[ãa]o|foram) ativadas/i;
const MEETING_RE = /^(in \d+ (min|minutes?|hours?)|em \d+ (min|minutos?|horas?)|starting now|now:|começando agora|agora:)/i;
const GROUP_PREFIX_RE = /^([^:]{1,60}):\s+/;
const COLORS = ['#5b5fc7', '#c4314b', '#237b4b', '#8f6200', '#0f6cbd',
    '#a33c93', '#4f6bed', '#ca5010', '#038387', '#6b2929'];
const MARGIN = 12;
const FOCUS_CLEAR_DELAY_MS = 1500;

function stripMarkup(text) {
    return (text ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function cleanBody(body) {
    const lines = stripMarkup(body).split('\n').map(l => l.trim()).filter(l => l);
    // O Chrome coloca a origem (ex.: "teams.microsoft.com") como primeira linha.
    if (lines.length && HOSTNAME_LINE_RE.test(lines[0]))
        lines.shift();
    return lines.join(' ');
}

// O Chrome põe a origem do site ("teams.cloud.microsoft") na 1ª linha do corpo.
function originOf(body) {
    const first = stripMarkup(body).split('\n').map(l => l.trim()).find(l => l);
    return first && HOSTNAME_LINE_RE.test(first) ? first : null;
}

function siteInitials(host) {
    const parts = host.replace(/^www\./, '').split('.').filter(p => p);
    const a = parts[0]?.[0] ?? '?';
    const b = parts.length > 2 ? parts[1][0] : parts[0]?.[1] ?? '';
    return (a + b).toUpperCase();
}

function senderName(title) {
    const t = stripMarkup(title).trim();
    return t.replace(NAME_SUFFIX_RE, '').trim() || t || 'Teams';
}

function classify(title, body) {
    if (SYSTEM_TITLE_RE.test(title))
        return {kind: 'system'};
    if (MEETING_RE.test(title)) {
        return {kind: 'meeting', key: 'teams:reunioes', name: 'Reuniões',
            label: title, text: body, initials: '📅'};
    }
    if (MENTION_RE.test(title)) {
        const sender = title.replace(MENTION_RE, '').trim() || title;
        return {kind: 'mention', key: sender.toLowerCase(), name: sender,
            label: `${sender} te mencionou`, text: body};
    }
    const m = body.match(GROUP_PREFIX_RE);
    if (m) {
        const prefix = m[1].trim();
        const looksLikeName = /^\p{Lu}[\p{L}.' -]*$/u.test(prefix) && prefix.split(/\s+/).length <= 4;
        // Em conversa direta o título já é o nome da pessoa ("Fulano de Tal" / "Fulano: ...").
        const sameAsTitle = title.toLowerCase().startsWith(prefix.toLowerCase());
        if (looksLikeName && !sameAsTitle) {
            return {kind: 'group', key: `grupo:${title.toLowerCase()}`, name: title,
                label: `${prefix} em ${title}`, text: body.slice(m[0].length)};
        }
    }
    const sender = senderName(title);
    return {kind: 'direct', key: sender.toLowerCase(), name: sender, label: sender, text: body};
}

function initials(name) {
    const parts = name.replace(/[([{].*$/, '').split(/[\s,]+/).filter(p => /\p{L}/u.test(p));
    if (!parts.length)
        return '?';
    const first = parts[0][0];
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + last).toUpperCase();
}

function colorFor(key) {
    let h = 0;
    for (const ch of key)
        h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
}

function hashKey(key) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, key, -1);
}

export default class TeamsBubblesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._entries = new Map();       // key -> entry
        this._watchedSources = new Set();
        this._watchedNotifications = new Set();
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'teams-bubbles']);
        GLib.mkdir_with_parents(this._cacheDir, 0o700);

        this._buildStack();
        this._buildIndicator();

        // Fontes de notificação
        Main.messageTray.connectObject(
            'source-added', (_tray, source) => this._watchSource(source),
            'source-removed', (_tray, source) => this._unwatchSource(source),
            this);
        for (const source of Main.messageTray.getSources()) {
            this._watchSource(source);
            for (const n of source.notifications ?? [])
                this._ingest(source, n, false);
        }

        // Layout / monitores / bloqueio de tela
        Main.layoutManager.connectObject('monitors-changed', () => this._relayout(), this);
        Main.sessionMode.connectObject('updated', () => this._updateVisibility(), this);
        this._settings.connectObject(
            'changed::monitor-connector', () => this._relayout(),
            this);

        // Limpar ao focar o Teams (opcional)
        global.display.connectObject('notify::focus-window', () => this._onFocusChanged(), this);

        this._refresh();
    }

    disable() {
        if (this._focusTimeoutId) {
            GLib.source_remove(this._focusTimeoutId);
            this._focusTimeoutId = 0;
        }
        global.display.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.messageTray.disconnectObject(this);
        for (const s of this._watchedSources)
            s.disconnectObject(this);
        for (const n of this._watchedNotifications)
            n.disconnectObject(this);
        this._watchedSources = null;
        this._watchedNotifications = null;

        this._settings?.disconnectObject(this);
        this._settings = null;

        this._indicator?.destroy();
        this._indicator = null;

        Main.layoutManager.removeChrome(this._tooltip);
        this._tooltip.destroy();
        this._tooltip = null;
        Main.layoutManager.removeChrome(this._stack);
        this._stack.destroy();
        this._stack = null;
        this._entries = null;
    }

    // ---------------------------------------------------------------- UI

    _buildStack() {
        this._stack = new St.BoxLayout({
            style_class: 'tb-stack',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            visible: false,
        });
        Main.layoutManager.addChrome(this._stack, {trackFullscreen: false});
        this._stack.connectObject(
            'notify::width', () => this._relayout(),
            'notify::height', () => this._relayout(),
            this);

        this._tooltip = new St.BoxLayout({
            style_class: 'tb-tooltip',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            visible: false,
        });
        this._tooltipTitle = new St.Label({style_class: 'tb-tooltip-title'});
        this._tooltipBody = new St.Label({style_class: 'tb-tooltip-body'});
        this._tooltipBody.clutter_text.line_wrap = true;
        this._tooltipBody.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        this._tooltipHint = new St.Label({
            style_class: 'tb-tooltip-hint',
            text: 'Clique: abrir  ·  Botão direito: descartar',
        });
        this._tooltip.add_child(this._tooltipTitle);
        this._tooltip.add_child(this._tooltipBody);
        this._tooltip.add_child(this._tooltipHint);
        Main.layoutManager.addChrome(this._tooltip, {trackFullscreen: false});
    }

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'Teams Bubbles', false);
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._indicatorIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${this.path}/icons/teams-bubbles-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this._indicatorCount = new St.Label({
            style_class: 'tb-panel-count',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._indicatorIcon);
        box.add_child(this._indicatorCount);
        this._indicator.add_child(box);

        const menu = this._indicator.menu;
        this._pendingSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._pendingSection);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const clearItem = new PopupMenu.PopupMenuItem('Limpar lista');
        clearItem.connect('activate', () => this._clearAll());
        menu.addMenuItem(clearItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._monitorMenu = new PopupMenu.PopupSubMenuMenuItem('Monitor');
        menu.addMenuItem(this._monitorMenu);

        const focusItem = new PopupMenu.PopupSwitchMenuItem(
            'Limpar ao focar o Teams', this._settings.get_boolean('clear-on-focus'));
        focusItem.connect('toggled', (_i, state) =>
            this._settings.set_boolean('clear-on-focus', state));
        menu.addMenuItem(focusItem);

        const groupItem = new PopupMenu.PopupSwitchMenuItem(
            'Grupos sem menção', this._settings.get_boolean('show-group-messages'));
        groupItem.connect('toggled', (_i, state) =>
            this._settings.set_boolean('show-group-messages', state));
        menu.addMenuItem(groupItem);

        const meetingItem = new PopupMenu.PopupSwitchMenuItem(
            'Lembretes de reunião', this._settings.get_boolean('show-meetings'));
        meetingItem.connect('toggled', (_i, state) =>
            this._settings.set_boolean('show-meetings', state));
        menu.addMenuItem(meetingItem);

        const chromeItem = new PopupMenu.PopupSwitchMenuItem(
            'Todas as notificações do Chrome', this._settings.get_boolean('capture-all-chrome'));
        chromeItem.connect('toggled', (_i, state) =>
            this._settings.set_boolean('capture-all-chrome', state));
        menu.addMenuItem(chromeItem);

        const bannerItem = new PopupMenu.PopupSwitchMenuItem(
            'Esconder pop-ups interceptados', this._settings.get_boolean('suppress-banners'));
        bannerItem.connect('toggled', (_i, state) =>
            this._settings.set_boolean('suppress-banners', state));
        menu.addMenuItem(bannerItem);

        const debugItem = new PopupMenu.PopupSwitchMenuItem(
            'Log de diagnóstico', this._settings.get_boolean('debug-log'));
        debugItem.connect('toggled', (_i, state) =>
            this._settings.set_boolean('debug-log', state));
        menu.addMenuItem(debugItem);

        menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            this._rebuildPendingSection();
            this._rebuildMonitorMenu();
            focusItem.setToggleState(this._settings.get_boolean('clear-on-focus'));
            groupItem.setToggleState(this._settings.get_boolean('show-group-messages'));
            meetingItem.setToggleState(this._settings.get_boolean('show-meetings'));
            chromeItem.setToggleState(this._settings.get_boolean('capture-all-chrome'));
            bannerItem.setToggleState(this._settings.get_boolean('suppress-banners'));
            debugItem.setToggleState(this._settings.get_boolean('debug-log'));
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    _rebuildPendingSection() {
        this._pendingSection.removeAll();
        if (this._entries.size === 0) {
            const item = new PopupMenu.PopupMenuItem('Nenhuma mensagem pendente', {reactive: false});
            this._pendingSection.addMenuItem(item);
            return;
        }
        for (const entry of this._sortedEntries()) {
            const label = entry.count > 1 ? `${entry.name} (${entry.count})` : entry.name;
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._open(entry));
            this._pendingSection.addMenuItem(item);
        }
    }

    _monitorList() {
        const mm = global.backend.get_monitor_manager();
        const list = [];
        for (const lm of mm.get_logical_monitors()) {
            const index = lm.get_number();
            const geo = Main.layoutManager.monitors[index];
            for (const mon of lm.get_monitors()) {
                list.push({
                    index,
                    connector: mon.get_connector(),
                    name: mon.get_display_name?.() ?? mon.get_connector(),
                    primary: index === Main.layoutManager.primaryIndex,
                    x: geo?.x ?? 0,
                });
            }
        }
        list.sort((a, b) => a.x - b.x);
        return list;
    }

    _rebuildMonitorMenu() {
        const sub = this._monitorMenu.menu;
        sub.removeAll();
        const current = this._settings.get_string('monitor-connector');
        const list = this._monitorList();
        const known = list.some(m => m.connector === current);

        const auto = new PopupMenu.PopupMenuItem('Principal (automático)');
        auto.setOrnament(!current || !known ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        auto.connect('activate', () => this._settings.set_string('monitor-connector', ''));
        sub.addMenuItem(auto);

        list.forEach((m, i) => {
            const pos = list.length === 1 ? ''
                : i === 0 ? ' · esquerda'
                    : i === list.length - 1 ? ' · direita' : ' · centro';
            const label = `${m.connector} · ${m.name}${pos}${m.primary ? ' (principal)' : ''}`;
            const item = new PopupMenu.PopupMenuItem(label);
            item.setOrnament(m.connector === current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._settings.set_string('monitor-connector', m.connector));
            sub.addMenuItem(item);
        });

        const sel = list.find(m => m.connector === current);
        this._monitorMenu.label.text = `Monitor: ${sel ? sel.connector : 'principal'}`;
    }

    _monitorIndex() {
        const connector = this._settings.get_string('monitor-connector');
        if (connector) {
            const m = this._monitorList().find(x => x.connector === connector);
            if (m && Main.layoutManager.monitors[m.index])
                return m.index;
        }
        return Main.layoutManager.primaryIndex;
    }

    _relayout() {
        if (!this._stack)
            return;
        const monitor = Main.layoutManager.monitors[this._monitorIndex()];
        if (!monitor)
            return;
        const [, w] = this._stack.get_preferred_width(-1);
        const [, h] = this._stack.get_preferred_height(w);
        const x = monitor.x + monitor.width - w - MARGIN;
        const y = monitor.y + Math.max(MARGIN, Math.round((monitor.height - h) / 2));
        if (this._stack.x !== x || this._stack.y !== y)
            this._stack.set_position(x, y);
    }

    _updateVisibility() {
        if (!this._stack)
            return;
        const locked = Main.sessionMode.isLocked;
        this._indicator.container.visible = !locked;
        const show = this._entries.size > 0 && !locked;
        this._stack.visible = show;
        if (!show)
            this._tooltip.hide();
    }

    _refresh() {
        const n = this._entries.size;
        this._indicatorCount.text = String(n);
        this._indicatorCount.visible = n > 0;
        if (n > 0)
            this._indicatorIcon.add_style_class_name('tb-panel-active');
        else
            this._indicatorIcon.remove_style_class_name('tb-panel-active');
        this._updateVisibility();
        this._relayout();
    }

    // ---------------------------------------------------------- Bubbles

    _sortedEntries() {
        return [...this._entries.values()].sort((a, b) => b.time - a.time);
    }

    _createBubble(entry) {
        const button = new St.Button({
            style_class: 'tb-bubble',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        const layers = new St.Widget({layout_manager: new Clutter.BinLayout()});
        const avatar = new St.Bin({
            style_class: 'tb-avatar',
            x_expand: true,
            y_expand: true,
        });
        const initialsLabel = new St.Label({
            style_class: 'tb-initials',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        avatar.set_child(initialsLabel);
        const badge = new St.Label({
            style_class: 'tb-badge',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        layers.add_child(avatar);
        layers.add_child(badge);
        button.set_child(layers);

        button.connect('clicked', (_b, clickedButton) => {
            if (clickedButton === Clutter.BUTTON_PRIMARY)
                this._open(entry);
            else
                this._dismiss(entry);
        });
        button.connect('notify::hover', () => {
            if (button.hover)
                this._showTooltip(entry);
            else if (this._tooltipEntry === entry)
                this._hideTooltip();
        });

        entry.widget = button;
        entry.avatar = avatar;
        entry.initialsLabel = initialsLabel;
        entry.badge = badge;

        button.set_pivot_point(0.5, 0.5);
        button.opacity = 0;
        button.scale_x = button.scale_y = 0.4;
        this._stack.insert_child_at_index(button, 0);
        button.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 350,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _updateBubble(entry) {
        if (entry.avatarPath) {
            const uri = GLib.filename_to_uri(entry.avatarPath, null);
            entry.avatar.style = `background-image: url("${uri}"); background-color: transparent;`;
            entry.initialsLabel.hide();
        } else {
            entry.avatar.style = `background-color: ${colorFor(entry.key)};`;
            entry.initialsLabel.text = entry.initials ?? initials(entry.name);
            entry.initialsLabel.show();
        }
        entry.badge.text = entry.count > 99 ? '99+' : String(entry.count);
        entry.badge.visible = entry.count > 1;
        if (this._tooltipEntry === entry)
            this._showTooltip(entry);
    }

    _bump(entry) {
        this._stack.set_child_at_index(entry.widget, 0);
        const w = entry.widget;
        w.remove_all_transitions();
        w.ease({
            scale_x: 1.18,
            scale_y: 1.18,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => w.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            }),
        });
    }

    _showTooltip(entry) {
        this._tooltipEntry = entry;
        this._tooltipTitle.text = entry.title;
        this._tooltipBody.text = entry.body || '';
        this._tooltipBody.visible = !!entry.body;
        this._tooltip.show();
        const [bx, by] = entry.widget.get_transformed_position();
        const [, bh] = entry.widget.get_transformed_size();
        const [, tw] = this._tooltip.get_preferred_width(-1);
        const [, th] = this._tooltip.get_preferred_height(tw);
        this._tooltip.set_position(Math.round(bx - tw - 10), Math.round(by + (bh - th) / 2));
    }

    _hideTooltip() {
        this._tooltipEntry = null;
        this._tooltip?.hide();
    }

    _removeEntry(entry, destroyNotifications) {
        if (!this._entries.has(entry.key))
            return;
        this._entries.delete(entry.key);
        if (this._tooltipEntry === entry)
            this._hideTooltip();

        if (destroyNotifications) {
            for (const n of [...entry.notifications]) {
                n.disconnectObject(this);
                this._watchedNotifications.delete(n);
                n.destroy();
            }
        }
        entry.notifications.clear();

        const w = entry.widget;
        w.reactive = false;
        w.ease({
            opacity: 0,
            scale_x: 0.4,
            scale_y: 0.4,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                w.destroy();
                this._refresh();
            },
        });
        this._refresh();
    }

    _dismiss(entry) {
        this._removeEntry(entry, true);
    }

    _clearAll() {
        for (const entry of [...this._entries.values()])
            this._removeEntry(entry, true);
    }

    _open(entry) {
        // A notificação mais recente ainda viva abre a conversa certa no Teams.
        const alive = [...entry.notifications];
        const latest = alive[alive.length - 1];
        const app = entry.app ?? (entry.kind === 'site' ? null : this._findTeamsApp());

        // Tira as outras da bandeja do GNOME para não acumularem.
        for (const n of alive.slice(0, -1)) {
            n.disconnectObject(this);
            this._watchedNotifications.delete(n);
            n.destroy();
        }
        if (latest) {
            latest.disconnectObject(this);
            this._watchedNotifications.delete(latest);
            entry.notifications.clear();
            latest.activate();
        }
        this._removeEntry(entry, false);

        // Garante que a janela venha para frente (Wayland pode ignorar o
        // pedido de foco vindo do próprio Chrome).
        app?.activate();
    }

    // ---------------------------------------------------- Notifications

    _isTeamsApp(app) {
        if (!app)
            return false;
        return /teams/i.test(app.get_name() ?? '') || /teams/i.test(app.get_id() ?? '');
    }

    _findTeamsApp() {
        const appSys = Shell.AppSystem.get_default();
        const running = appSys.get_running().find(a => this._isTeamsApp(a));
        if (running)
            return running;
        return appSys.get_installed()
            .map(info => appSys.lookup_app(info.get_id()))
            .find(a => a && this._isTeamsApp(a) && /^(chrome|msedge|chromium|brave)-/.test(a.get_id())) ?? null;
    }

    _watchSource(source) {
        if (this._watchedSources.has(source))
            return;
        this._watchedSources.add(source);
        source.connectObject(
            'notification-added', (_s, n) => this._ingest(source, n, true),
            'destroy', () => this._unwatchSource(source),
            this);
    }

    _unwatchSource(source) {
        if (!this._watchedSources?.has(source))
            return;
        this._watchedSources.delete(source);
        source.disconnectObject(this);
    }

    // Log só quando a opção "Log de diagnóstico" está ligada (desligada por padrão).
    _debug(msg) {
        if (this._settings.get_boolean('debug-log'))
            console.log(`[teams-bubbles] ${msg}`);
    }

    _isChromeSource(source) {
        return /chrome|chromium|msedge|brave/i.test(source.app?.get_id() ?? '') ||
            /chrome|chromium|edge|brave/i.test(source.title ?? '');
    }

    // 'teams', 'site' (outro site do Chrome, se habilitado) ou null (ignorar).
    _scopeOf(source, n) {
        // A origem do site é decisiva: o processo do Chrome é o mesmo para
        // todos os sites/PWAs, então o "app" da fonte pode ser o Teams mesmo
        // quando a notificação veio de outro site.
        const origin = originOf(n.body);
        if (origin) {
            if (TEAMS_HOST_RE.test(origin))
                return {scope: 'teams', origin};
            if (this._settings.get_boolean('capture-all-chrome') && this._isChromeSource(source))
                return {scope: 'site', origin};
            this._debug(`ignorado (origem ${origin})`);
            return null;
        }
        return this._isTeamsApp(source.app) ? {scope: 'teams', origin: null} : null;
    }

    _ingest(source, n, isNew) {
        const scope = this._scopeOf(source, n);
        if (!scope)
            return;

        // O Chrome manda as notificações como "urgentes", que o GNOME mostra
        // mesmo com banners desligados. Rebaixa para não aparecer pop-up.
        if (this._settings.get_boolean('suppress-banners')) {
            n.urgency = MessageTray.Urgency.LOW;
            n.acknowledged = true;
        }

        if (!this._watchedNotifications.has(n)) {
            this._watchedNotifications.add(n);
            n.connectObject(
                // O site pode fechar a notificação sozinho; a bolha fica.
                'destroy', () => {
                    this._watchedNotifications?.delete(n);
                    for (const e of this._entries?.values() ?? [])
                        e.notifications.delete(n);
                },
                // Notificação substituída (mesma "tag") = nova mensagem.
                'notify::body', () => this._scheduleReingest(source, n),
                this);
        }
        for (const e of this._entries.values())
            e.notifications.delete(n);

        const title = stripMarkup(n.title).trim();
        const body = cleanBody(n.body);
        let info;
        if (scope.scope === 'site') {
            // Outros sites: uma bolha por site, sem tentar entender o conteúdo.
            const host = scope.origin.replace(/^www\./, '');
            info = {kind: 'site', key: `site:${host}`, name: host,
                label: title || host, text: body ? `${host} · ${body}` : host,
                initials: siteInitials(host)};
        } else {
            info = classify(title, body);
        }
        this._debug(`${info.kind}: ${JSON.stringify(title)}`);
        if (info.kind === 'system')
            return;
        if (info.kind === 'meeting' && !this._settings.get_boolean('show-meetings'))
            return;
        if (info.kind === 'group' && !this._settings.get_boolean('show-group-messages'))
            return;

        let text = info.text;
        if (text.length > 240)
            text = `${text.slice(0, 240)}…`;

        let entry = this._entries.get(info.key);
        const created = !entry;
        if (!entry) {
            entry = {
                key: info.key,
                kind: info.kind,
                name: info.name,
                initials: info.initials ?? null,
                title: info.label,
                body: text,
                count: 0,
                time: 0,
                avatarPath: null,
                app: null,
                notifications: new Set(),
            };
            this._entries.set(info.key, entry);
            this._createBubble(entry);
        }

        entry.title = info.label;
        entry.body = text;
        entry.count += 1;
        entry.time = GLib.get_monotonic_time();
        if (info.kind === 'site') {
            entry.app = source.app && !this._isTeamsApp(source.app)
                ? source.app
                : Shell.AppSystem.get_default().lookup_app('google-chrome.desktop');
        } else if (this._isTeamsApp(source.app)) {
            entry.app = source.app;
        }
        const avatar = this._saveAvatar(n.gicon, info.key);
        if (avatar)
            entry.avatarPath = avatar;
        entry.notifications.add(n);

        this._updateBubble(entry);
        if (!created && isNew)
            this._bump(entry);
        this._refresh();
    }

    _scheduleReingest(source, n) {
        if (n._tbIdle)
            return;
        n._tbIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            n._tbIdle = 0;
            if (this._watchedNotifications?.has(n))
                this._ingest(source, n, true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveAvatar(gicon, key) {
        try {
            if (!gicon)
                return null;
            if (gicon instanceof Gio.FileIcon) {
                // O Chrome apaga o arquivo temporário depois; guarda uma cópia.
                const [, bytes] = gicon.get_file().load_contents(null);
                const fileHash = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA1, bytes);
                const path = GLib.build_filenamev([this._cacheDir,
                    `${hashKey(key).slice(0, 16)}-${fileHash.slice(0, 16)}.png`]);
                if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                    GLib.file_set_contents(path, bytes);
                this._cleanupAvatars(key, path);
                return path;
            }
            if (gicon instanceof GdkPixbuf.Pixbuf) {
                const size = Math.min(gicon.get_width(), gicon.get_height());
                const square = gicon.get_width() !== gicon.get_height()
                    ? gicon.new_subpixbuf(
                        Math.floor((gicon.get_width() - size) / 2),
                        Math.floor((gicon.get_height() - size) / 2), size, size)
                    : gicon;
                const pixHash = GLib.compute_checksum_for_bytes(
                    GLib.ChecksumType.SHA1, gicon.read_pixel_bytes());
                // Nome muda quando a imagem muda, para o St não reutilizar a textura antiga.
                const path = GLib.build_filenamev([this._cacheDir,
                    `${hashKey(key).slice(0, 16)}-${pixHash.slice(0, 16)}.png`]);
                if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                    square.savev(path, 'png', [], []);
                this._cleanupAvatars(key, path);
                return path;
            }
        } catch (e) {
            console.warn(`[teams-bubbles] avatar: ${e.message}`);
        }
        return null;
    }

    _cleanupAvatars(key, keep) {
        const prefix = hashKey(key).slice(0, 16);
        const dir = Gio.File.new_for_path(this._cacheDir);
        try {
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const name = info.get_name();
                const full = GLib.build_filenamev([this._cacheDir, name]);
                if (name.startsWith(prefix) && full !== keep)
                    dir.get_child(name).delete(null);
            }
            en.close(null);
        } catch (_e) {
        }
    }

    // ------------------------------------------------------------- Focus

    _onFocusChanged() {
        if (this._focusTimeoutId) {
            GLib.source_remove(this._focusTimeoutId);
            this._focusTimeoutId = 0;
        }
        if (!this._settings.get_boolean('clear-on-focus') || this._entries.size === 0)
            return;
        const win = global.display.focus_window;
        const app = win ? Shell.WindowTracker.get_default().get_window_app(win) : null;
        if (!this._isTeamsApp(app))
            return;
        this._focusTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOCUS_CLEAR_DELAY_MS, () => {
            this._focusTimeoutId = 0;
            const w = global.display.focus_window;
            const a = w ? Shell.WindowTracker.get_default().get_window_app(w) : null;
            if (this._isTeamsApp(a))
                this._clearAll();
            return GLib.SOURCE_REMOVE;
        });
    }
}
