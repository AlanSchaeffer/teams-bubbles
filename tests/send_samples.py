#!/usr/bin/env python3
"""Envia notificações no formato que o Chrome usa para o Teams e outros sites.

Uso: send_samples.py <fase> <log> <segundos>
Fica conectado à D-Bus por <segundos> (como o Chrome, que continua rodando),
registrando no <log> os sinais ActionInvoked / NotificationClosed.
"""
import os
import sys

import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf, Gio, GLib  # noqa: E402

phase, log_path, hold = sys.argv[1], sys.argv[2], int(sys.argv[3])
out = open(log_path, 'a')
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
tmpdir = os.path.dirname(os.path.abspath(log_path))

TEAMS = 'teams.cloud.microsoft'

SAMPLES = {
    'a': [
        ('Nice job! Notifications are now on.', TEAMS, 'x', None),
        ('Fulano de Tal', TEAMS, 'Oi, tudo bem?', 0x3366ccff),
        ('Nome do Grupo', TEAMS, 'Beltrano: opa', 0x22aa55ff),
        ('Fulano de Tal @mentioned you', TEAMS, 'Ciclano, teste', 0x3366ccff),
        ('In 5 min: Daily', TEAMS, 'Teams meeting', None),
        ('Planning', 'calendar.google.com', '10:00 – 11:00', None),
        ('Beltrano Souza', TEAMS, 'Beltrano: pode ver?', None),
    ],
    'b': [
        ('Nome do Grupo', TEAMS, 'Beltrano: segunda', 0x22aa55ff),
        ('Planning', 'calendar.google.com', '10:00 – 11:00', None),
    ],
}

counter = [0]


def notify(title, origin, body, color):
    hints = {
        'desktop-entry': GLib.Variant('s', 'google-chrome'),
        'urgency': GLib.Variant('y', 2),  # o Chrome manda tudo como crítico
    }
    if color is not None:
        counter[0] += 1
        # O Chrome usa um arquivo temporário que apaga depois.
        path = os.path.join(tmpdir, f'img-{phase}-{counter[0]}.png')
        pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, True, 8, 96, 96)
        pb.fill(color)
        pb.savev(path, 'png', [], [])
        hints['image-path'] = GLib.Variant('s', path)
        GLib.timeout_add(500, lambda: (os.remove(path), False)[1])
    r = bus.call_sync(
        'org.freedesktop.Notifications', '/org/freedesktop/Notifications',
        'org.freedesktop.Notifications', 'Notify',
        GLib.Variant('(susssasa{sv}i)', (
            'Google Chrome', 0, '', title, f'{origin}\n\n{body}',
            ['default', 'Activate', 'settings', 'Settings'], hints, 0)),
        None, 0, -1, None)
    out.write(f'sent {r.unpack()[0]} {title}\n')
    out.flush()


def on_signal(_c, _s, _p, _i, name, params, *_a):
    if name in ('ActionInvoked', 'NotificationClosed'):
        out.write(f'signal {name} {params.unpack()}\n')
        out.flush()


bus.signal_subscribe(None, 'org.freedesktop.Notifications', None,
                     '/org/freedesktop/Notifications', None, 0, on_signal)

queue = list(SAMPLES[phase])


def step():
    if queue:
        notify(*queue.pop(0))
        return True
    return False


GLib.timeout_add(80, step)
loop = GLib.MainLoop()
GLib.timeout_add_seconds(hold, loop.quit)
loop.run()
