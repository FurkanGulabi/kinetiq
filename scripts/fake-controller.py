#!/usr/bin/env python3
"""
Kinetiq fake controller: a FluidNC / GRBL 1.1 stand-in on a pseudo-terminal, for developing and
testing the UI without a machine. Development only; it is not a simulator of real motion.

    npm run fake-controller            # terminal 1 (prints the port and the rc file it wrote)
    npm run dev:fake                   # terminal 2: Kinetiq using that rc file

Then pick the fake port in Kinetiq and Connect. See docs/FAKE_CONTROLLER.md.

What it does:
  - banner, `?` status reports (MPos, FS, WCO, Ov), `ok` / `error:N`, $I, $G, $#, $$
  - motion queue with simulated feeds (--speed x the programmed feed), G0/G1/G2/G3 (arcs as
    straight lines), G90/G91, G53, G10 L20 (set work zero), G4 dwell, M3/M5
  - jogging ($J=), jog cancel (0x85), feed hold (!), resume (~), soft reset (Ctrl-X), overrides
  - homing ($H), alarm + unlock ($X) (--alarm starts in Alarm)
  - probing G38.2 / G38.3 against a surface at --surface-z (slightly tilted and wavy unless
    --flat, so bed leveling draws a real height map); --probe-miss never touches (ALARM:5)
  - FluidNC config file commands used by the Settings editor: $Config/Filename, $LocalFS/List,
    $LocalFS/Show, $LocalFS/Delete, $LocalFS/Rename, $CD, $SS, and $Xmodem/Receive (XModem-1K,
    CRC16). Files live in memory; Ctrl-X / $Bye "reboot" loads the saved config as running.

Needs Python 3.8+ and a POSIX system (macOS, Linux): it uses the standard `pty` module.
"""
import argparse
import hashlib
import json
import math
import os
import sys

if os.name != 'posix':
    sys.exit('fake-controller.py needs macOS or Linux (it uses the POSIX pty module). '
             'On Windows run it, and Kinetiq, inside WSL. See docs/FAKE_CONTROLLER.md.')

import pty
import queue
import re
import tempfile
import threading
import time
import tty

parser = argparse.ArgumentParser(description='Kinetiq fake FluidNC/GRBL controller (development only).')
parser.add_argument('--link', default=os.path.join(tempfile.gettempdir(), 'kinetiq-fake0'),
                    help='path of the symlink to the fake serial port (default: %(default)s)')
parser.add_argument('--rc', default=os.path.join(tempfile.gettempdir(), 'kinetiq-fake.rc'),
                    help='Kinetiq rc file to write with this port in "ports" (default: %(default)s)')
parser.add_argument('--speed', type=float, default=4.0, help='motion runs at this multiple of the programmed feed')
parser.add_argument('--alarm', action='store_true', help='start in Alarm (as after power-up with homing enabled)')
parser.add_argument('--surface-z', type=float, default=-20.0,
                    help='machine Z of the probe surface at X0 Y0; it tilts and waves slightly across X/Y so '
                         'bed leveling has something to map (default: %(default)s)')
parser.add_argument('--flat', action='store_true', help='make the probe surface flat')
parser.add_argument('--probe-miss', action='store_true', help='probing never touches (ALARM:5)')
parser.add_argument('--verbose', '-v', action='store_true', help='log every line received')
parser.add_argument('--trace', metavar='FILE',
                    help='append every received line, real-time byte and XModem transfer to FILE, one record per '
                         'line with a relative time in ms (protocol diff, scripts/protocol-scenarios)')
args = parser.parse_args()

VERSION = 'v4.0.1 (fake)'
BANNER = "\r\nGrbl 3.9 [FluidNC %s '$' for help]\r\n" % VERSION
CONFIG_FILE = 'config.yaml'
SAMPLE_CONFIG = """\
name: Kinetiq fake
board: Fake ESP32
stepping:
  engine: RMT
  idle_ms: 255
  pulse_us: 4
  dir_delay_us: 1
  disable_delay_us: 0
axes:
  shared_stepper_disable_pin: NO_PIN
  x:
    steps_per_mm: 800.000
    max_rate_mm_per_min: 5000.000
    acceleration_mm_per_sec2: 200.000
    max_travel_mm: 300.000
    soft_limits: false
    homing:
      cycle: 2
      positive_direction: false
      mpos_mm: 0.000
      feed_mm_per_min: 300.000
      seek_mm_per_min: 2000.000
    motor0:
      limit_neg_pin: gpio.35
      stepstick:
        step_pin: gpio.12
        direction_pin: gpio.14
  y:
    steps_per_mm: 800.000
    max_rate_mm_per_min: 5000.000
    acceleration_mm_per_sec2: 200.000
    max_travel_mm: 300.000
    homing:
      cycle: 2
      mpos_mm: 0.000
    motor0:
      limit_neg_pin: gpio.34
      stepstick:
        step_pin: gpio.26
        direction_pin: gpio.15
  z:
    steps_per_mm: 800.000
    max_rate_mm_per_min: 1000.000
    acceleration_mm_per_sec2: 100.000
    max_travel_mm: 80.000
    homing:
      cycle: 1
      positive_direction: true
      mpos_mm: 0.000
    motor0:
      limit_pos_pin: gpio.39
      stepstick:
        step_pin: gpio.27
        direction_pin: gpio.33
probe:
  pin: gpio.36:low
  check_mode_start: true
spindle:
  PWM:
    pwm_hz: 5000
    output_pin: gpio.2
    speed_map: 0=0.000% 24000=100.000%
"""

# --- pty -------------------------------------------------------------------------------------------

master, slave = pty.openpty()
tty.setraw(slave)
try:
    os.unlink(args.link)
except FileNotFoundError:
    pass
os.symlink(os.ttyname(slave), args.link)
with open(args.rc, 'w') as f:
    json.dump({'ports': [{'path': args.link, 'manufacturer': 'Kinetiq fake controller'}]}, f, indent=2)

write_lock = threading.Lock()


def write(text):
    data = text.encode() if isinstance(text, str) else text
    with write_lock:
        os.write(master, data)


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


# --- trace (--trace) -------------------------------------------------------------------------------
# One record per received unit, in arrival order: "<ms since start>\t<record>". A record is a line as
# received (before handling; bytes outside printable ASCII escaped as \xNN), a real-time byte as a
# token (<?>, <!>, <~>, <0x18>, <0x85>, ...), or one "XMODEM ..." summary per file transfer instead of
# its raw blocks. Line buffered, so a reader can follow the file while a scenario runs.

trace_file = open(args.trace, 'a', encoding='utf-8', buffering=1) if args.trace else None
trace_lock = threading.Lock()
trace_start = time.monotonic()
REALTIME_TOKENS = {0x3F: '<?>', 0x21: '<!>', 0x7E: '<~>'}


def trace(record):
    if trace_file is None:
        return
    with trace_lock:
        trace_file.write('%.1f\t%s\n' % ((time.monotonic() - trace_start) * 1000, record))


def trace_char(b):
    if b == 0x5C:
        return '\\\\'  # a backslash is doubled so escapes stay unambiguous
    return chr(b) if 0x20 <= b < 0x7F else '\\x%02X' % b


def trace_line(data):
    trace(''.join(trace_char(b) for b in data))


def trace_realtime(byte):
    trace(REALTIME_TOKENS.get(byte, '<0x%02X>' % byte))


# --- machine state ---------------------------------------------------------------------------------

lock = threading.RLock()
S = {
    'state': 'Alarm' if args.alarm else 'Idle',
    'pos': [0.0, 0.0, 0.0],      # machine position, mm
    'wco': [0.0, 0.0, 0.0],      # work coordinate offset (G54)
    'feed': 0.0,
    'absolute': True,
    'queue': [],                 # planned moves {t, f, jog}
    'hold': False,
    'ov': [100, 100, 100],       # feed, rapid, spindle
    'spindle': 0,
    'prb': None,
}
files = {CONFIG_FILE: SAMPLE_CONFIG}
running_config = SAMPLE_CONFIG
MAX_QUEUE = 12  # roughly a planner buffer: `ok` is held back while it is full
RAPID = 5000.0


def status_report():
    with lock:
        p, w = S['pos'], S['wco']
        moving = bool(S['queue'])
        state = 'Hold:0' if S['hold'] and moving else S['state']
        feed = S['queue'][0]['f'] if moving and not S['hold'] else 0
        return '<%s|MPos:%.3f,%.3f,%.3f|FS:%d,%d|WCO:%.3f,%.3f,%.3f|Ov:%d,%d,%d>\r\n' % (
            state, p[0], p[1], p[2], feed, S['spindle'], w[0], w[1], w[2], *S['ov'])


def words(line):
    return {k: float(v) for k, v in re.findall(r'([A-Z])\s*([-+]?\d*\.?\d+)', line)}


def target(wd, absolute, machine=False):
    with lock:
        t = list(S['queue'][-1]['t']) if S['queue'] else list(S['pos'])
        for i, axis in enumerate('XYZ'):
            if axis in wd:
                if machine:
                    t[i] = wd[axis]
                elif absolute:
                    t[i] = wd[axis] + S['wco'][i]
                else:
                    t[i] += wd[axis]
        return t


def enqueue(t, feed, jog=False):
    while True:
        with lock:
            if len(S['queue']) < MAX_QUEUE:
                S['queue'].append({'t': t, 'f': max(feed, 1.0), 'jog': jog})
                return
        time.sleep(0.005)


def wait_idle():
    while True:
        with lock:
            if not S['queue']:
                return
        time.sleep(0.005)


def surface_z(x, y):
    """Machine Z of the probe surface: a slightly tilted, gently waving bed."""
    if args.flat:
        return args.surface_z
    return args.surface_z + 0.004 * x - 0.003 * y + 0.05 * math.sin(x / 15) * math.cos(y / 20)


def alarm(code):
    with lock:
        S['queue'].clear()
        S['state'] = 'Alarm'
    write('ALARM:%d\r\n' % code)


# --- XModem-1K receive -----------------------------------------------------------------------------

SOH, STX, EOT, ACK, NAK, CAN, CTRL_Z = 0x01, 0x02, 0x04, 0x06, 0x15, 0x18, 0x1A
xmodem = None  # active transfer: {'name', 'buf', 'data', 'expect', 'started', 'done'}


def crc16(data):
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def xmodem_byte(byte):
    """Feed one received byte to the active transfer (called from the reader thread)."""
    global xmodem
    x = xmodem
    buf = x['buf']
    if not buf:
        if byte == EOT:
            write(bytes([ACK]))
            data = bytes(x['data'])
            # Ctrl-Z padding is stripped from the end of the last block only.
            data = data.rstrip(bytes([CTRL_Z]))
            files[x['name']] = data.decode(errors='replace')
            x['received'] = len(data)
            trace('XMODEM %s bytes=%d blocks=%d naks=%d noise=%d sha256=%s' % (
                x['name'], len(data), x['blocks'], x['naks'], x['noise'], hashlib.sha256(data).hexdigest()[:16]))
            xmodem = None
            x['done'].set()
            return
        if byte == CAN:
            trace('XMODEM %s cancelled after blocks=%d naks=%d noise=%d' % (x['name'], x['blocks'], x['naks'], x['noise']))
            xmodem = None
            x['received'] = -1
            x['done'].set()
            return
        if byte not in (SOH, STX):
            x['noise'] += 1
            return  # noise between blocks
        x['started'] = True
    buf.append(byte)
    size = 1024 if buf[0] == STX else 128
    if len(buf) < 3 + size + 2:
        return
    block, inverse, payload = buf[1], buf[2], bytes(buf[3:3 + size])
    crc = (buf[3 + size] << 8) | buf[4 + size]
    buf.clear()
    if (block + inverse) & 0xFF != 0xFF or crc16(payload) != crc:
        x['naks'] += 1
        write(bytes([NAK]))
        return
    if block == x['expect'] & 0xFF:
        x['data'] += payload
        x['expect'] += 1
        x['blocks'] += 1
    write(bytes([ACK]))  # a repeated block is ACKed again but not stored twice


def xmodem_receive(name):
    global xmodem
    done = threading.Event()
    x = {'name': name, 'buf': bytearray(), 'data': bytearray(), 'expect': 1, 'started': False, 'done': done, 'received': 0,
         'blocks': 0, 'naks': 0, 'noise': 0}
    xmodem = x
    for _ in range(16):  # 'C' asks for CRC mode, about every second until the first block
        if x['started'] or done.is_set():
            break
        write(b'C')
        if done.wait(1.0):
            break
    if not done.wait(30):
        xmodem = None
        trace('XMODEM %s timeout after blocks=%d' % (name, x['blocks']))
        return 'error:3'
    if x['received'] < 0:
        return '[MSG:ERR: Xmodem cancelled]\r\nerror:3'
    log('xmodem: received %d bytes -> %s' % (x['received'], name))
    return '[MSG:INFO: Received %d bytes to file /littlefs/%s]\r\nok' % (x['received'], name)


# --- line commands ---------------------------------------------------------------------------------

def handle_line(raw):
    global running_config
    line = raw.strip()
    upper = line.upper()
    if not upper:
        return 'ok'

    # $ commands (FluidNC is case-insensitive for the command, file names keep their case)
    if upper == '$I':
        return '[VER:3.9 FluidNC %s:]\r\n[OPT:PHS]\r\n[MSG: Machine: Kinetiq fake]\r\nok' % VERSION
    if upper == '$G':
        with lock:
            return '[GC:G0 G54 G17 G21 %s G94 M%d M9 T0 F%d S%d]\r\nok' % (
                'G90' if S['absolute'] else 'G91', 3 if S['spindle'] else 5, S['feed'], S['spindle'])
    if upper == '$#':
        with lock:
            prb = S['prb'] or (0.0, 0.0, 0.0)
            return ('[G54:%.3f,%.3f,%.3f]\r\n[G55:0.000,0.000,0.000]\r\n[G56:0.000,0.000,0.000]\r\n'
                    '[G57:0.000,0.000,0.000]\r\n[G58:0.000,0.000,0.000]\r\n[G59:0.000,0.000,0.000]\r\n'
                    '[G28:0.000,0.000,0.000]\r\n[G30:0.000,0.000,0.000]\r\n[G92:0.000,0.000,0.000]\r\n'
                    '[TLO:0.000]\r\n[PRB:%.3f,%.3f,%.3f:%d]\r\nok' % (*S['wco'], *prb, 1 if S['prb'] else 0))
    if upper == '$$':
        return '$0=4\r\n$1=255\r\n$10=1\r\n$13=0\r\n$20=0\r\n$21=0\r\n$22=1\r\n$110=5000\r\n$111=5000\r\n$112=1000\r\nok'
    if upper == '$X':
        with lock:
            if S['state'] == 'Alarm':
                S['state'] = 'Idle'
        return '[MSG:INFO: Caution: Unlocked]\r\nok'
    if upper.startswith('$H'):
        with lock:
            S['state'] = 'Home'
        time.sleep(1.2)
        with lock:
            S['pos'] = [0.0, 0.0, 0.0]
            S['state'] = 'Idle'
        return '[MSG:INFO: Homed]\r\nok'
    if upper.startswith('$J='):
        with lock:
            if S['state'] == 'Alarm':
                return 'error:9'
        body = upper[3:]
        wd = words(body)
        machine = 'G53' in body
        absolute = 'G90' in body or ('G91' not in body and S['absolute'])
        enqueue(target(wd, absolute, machine), wd.get('F', 1000), jog=True)
        return 'ok'
    if upper == '$CONFIG/FILENAME':
        return '$Config/Filename=%s\r\nok' % CONFIG_FILE
    if upper == '$LOCALFS/LIST':
        out = ['[FILE: %s|SIZE:%d]' % (name, len(text.encode())) for name, text in sorted(files.items())]
        used = sum(len(t.encode()) for t in files.values())
        out.append('[MSG:INFO: Free: %.2f KB Used: %.2f KB Total: 192.00 KB]' % (192 - used / 1024, used / 1024))
        return '\r\n'.join(out) + '\r\nok'
    if upper.startswith('$LOCALFS/SHOW='):
        name = line.split('=', 1)[1].strip().lstrip('/')
        if name not in files:
            return '[MSG:ERR: No such file]\r\nerror:60'
        # FluidNC sends the file line by line; the serial reader drops empty lines.
        return '\r\n'.join(l for l in files[name].split('\n') if l.strip()) + '\r\nok'
    if upper.startswith('$LOCALFS/DELETE='):
        name = line.split('=', 1)[1].strip().lstrip('/')
        if files.pop(name, None) is None:
            return 'error:60'
        return 'ok'
    if upper.startswith('$LOCALFS/RENAME='):
        src, _, dst = line.split('=', 1)[1].partition('>')
        src, dst = src.strip().lstrip('/'), dst.strip().lstrip('/')
        if src not in files:
            return 'error:60'
        files[dst] = files.pop(src)
        return 'ok'
    if upper.startswith('$XMODEM/RECEIVE='):
        return xmodem_receive(line.split('=', 1)[1].strip().lstrip('/'))
    if upper == '$CD':
        return '\r\n'.join(l for l in running_config.split('\n') if l.strip()) + '\r\nok'
    if upper == '$SS':
        return ('[MSG:INFO: FluidNC %s]\r\n[MSG:INFO: Local filesystem type is littlefs]\r\n'
                '[MSG:INFO: Configuration file:%s]\r\n[MSG:INFO: Machine Kinetiq fake]\r\n'
                '[MSG:INFO: Board Fake ESP32]\r\n[MSG:INFO: X Axis driver errors: 0]\r\nok' % (VERSION, CONFIG_FILE))
    if upper == '$BYE':
        reboot()
        return None
    if upper.startswith('$'):
        return 'ok'

    # G-code
    code = re.sub(r'\(.*?\)|;.*$', '', upper)
    wd = words(code)
    gs = re.findall(r'G(\d+(?:\.\d+)?)', code)
    unsupported = [g for g in gs if g.strip('0') != '' and g.lstrip('0') not in SUPPORTED_G]
    if unsupported:
        return 'error:20'  # unsupported or invalid g-code command
    with lock:
        if S['state'] == 'Alarm' and (wd.keys() & set('XYZ')):
            return 'error:9'
        if 'F' in wd:
            S['feed'] = wd['F']
        if '90' in gs:
            S['absolute'] = True
        if '91' in gs:
            S['absolute'] = False
        if 'M' in wd and int(wd['M']) in (3, 4):
            S['spindle'] = int(wd.get('S', S['spindle'] or 10000))
        if 'M' in wd and int(wd['M']) == 5:
            S['spindle'] = 0

    if '10' in gs and wd.get('L') == 20:
        wait_idle()  # not planned: applies after the moves before it
        with lock:
            for i, axis in enumerate('XYZ'):
                if axis in wd:
                    S['wco'][i] = S['pos'][i] - wd[axis]
        return 'ok'
    if '38.2' in gs or '38.3' in gs:
        wait_idle()
        with lock:
            start = list(S['pos'])
        end = target(wd, S['absolute'])
        feed = wd.get('F', S['feed'] or 100)
        z_touch = surface_z(end[0], end[1])
        if start[2] <= z_touch:
            return 'error:9' if '38.2' in gs else 'ok'  # already touching
        if args.probe_miss or end[2] > z_touch:
            enqueue(end, feed)
            wait_idle()
            if '38.2' in gs:
                alarm(5)  # probe fail: no contact
                return 'error:9'
            return 'ok'
        contact = [end[0], end[1], z_touch]
        enqueue(contact, feed)
        wait_idle()
        with lock:
            S['prb'] = tuple(contact)
        return '[PRB:%.3f,%.3f,%.3f:1]\r\nok' % tuple(contact)
    if '4' in gs and 'P' in wd:
        wait_idle()
        time.sleep(min(wd['P'], 5))
        return 'ok'
    if wd.keys() & set('XYZ') and not ('28' in gs or '30' in gs or '92' in gs):
        rapid = any(g.strip('0') == '' for g in gs)  # G0 / G00
        machine = '53' in gs
        enqueue(target(wd, S['absolute'] and not machine, machine), RAPID if rapid else (S['feed'] or 500))
    return 'ok'


# G-codes GRBL 1.1 / FluidNC accept (others answer error:20).
SUPPORTED_G = {'1', '2', '3', '4', '10', '17', '18', '19', '20', '21', '28', '28.1', '30', '30.1', '38.2', '38.3',
               '38.4', '38.5', '40', '43.1', '49', '53', '54', '55', '56', '57', '58', '59', '61', '80', '90', '90.1',
               '91', '91.1', '92', '92.1', '93', '94'}


# --- threads ---------------------------------------------------------------------------------------

lines = queue.Queue()


def reboot():
    global running_config
    with lock:
        S['queue'].clear()
        S['hold'] = False
        S['spindle'] = 0
        S['state'] = 'Alarm' if args.alarm else 'Idle'
    while not lines.empty():
        try:
            lines.get_nowait()
        except queue.Empty:
            break
    running_config = files.get(CONFIG_FILE, running_config)
    write(BANNER)


def worker():
    """Line commands run here, in order, so `?` and other realtime bytes are answered meanwhile."""
    while True:
        line = lines.get()
        if args.verbose:
            log('<', line)
        reply = handle_line(line)
        if reply is not None:
            write(reply + '\r\n')


def motion():
    last = time.time()
    while True:
        time.sleep(0.01)
        now = time.time()
        dt, last = now - last, now
        with lock:
            q = S['queue']
            if not q:
                if S['state'] in ('Run', 'Jog'):
                    S['state'] = 'Idle'
                continue
            if S['hold'] or S['state'] == 'Alarm':
                continue
            move = q[0]
            S['state'] = 'Jog' if move['jog'] else 'Run'
            override = (S['ov'][1] if move['f'] >= RAPID else S['ov'][0]) / 100
            step = move['f'] / 60 * args.speed * override * dt
            p, t = S['pos'], move['t']
            d = math.dist(p, t)
            if d <= step:
                S['pos'] = list(t)
                q.pop(0)
            else:
                S['pos'] = [p[i] + (t[i] - p[i]) * step / d for i in range(3)]


def realtime(byte):
    with lock:
        ov = S['ov']
        if byte == 0x21:  # !
            S['hold'] = True
            if S['queue'] and S['queue'][0]['jog']:
                S['queue'] = [m for m in S['queue'] if not m['jog']]  # hold cancels a jog
        elif byte == 0x7E:  # ~
            S['hold'] = False
        elif byte == 0x85:  # jog cancel
            S['queue'] = [m for m in S['queue'] if not m['jog']]
        elif byte == 0x90: ov[0] = 100
        elif byte == 0x91: ov[0] = min(200, ov[0] + 10)
        elif byte == 0x92: ov[0] = max(10, ov[0] - 10)
        elif byte == 0x93: ov[0] = min(200, ov[0] + 1)
        elif byte == 0x94: ov[0] = max(10, ov[0] - 1)
        elif byte == 0x95: ov[1] = 100
        elif byte == 0x96: ov[1] = 50
        elif byte == 0x97: ov[1] = 25
        elif byte == 0x99: ov[2] = 100
        elif byte == 0x9A: ov[2] = min(200, ov[2] + 10)
        elif byte == 0x9B: ov[2] = max(10, ov[2] - 10)
        elif byte == 0x9C: ov[2] = min(200, ov[2] + 1)
        elif byte == 0x9D: ov[2] = max(10, ov[2] - 1)


def reader():
    buf = bytearray()
    while True:
        try:
            data = os.read(master, 4096)
        except OSError:
            time.sleep(0.05)  # no one has the port open
            continue
        for byte in data:
            if xmodem is not None:
                xmodem_byte(byte)
                continue
            if byte == 0x3F:  # ?
                trace_realtime(byte)
                write(status_report())
            elif byte == 0x18:  # Ctrl-X soft reset
                trace_realtime(byte)
                buf.clear()
                reboot()
            elif byte in (0x21, 0x7E) or byte >= 0x80:
                trace_realtime(byte)
                realtime(byte)
            elif byte in (0x0A, 0x0D):
                if buf.strip():
                    trace_line(buf)
                    lines.put(buf.decode(errors='ignore'))
                buf.clear()
            else:
                buf.append(byte)


threading.Thread(target=motion, daemon=True).start()
threading.Thread(target=worker, daemon=True).start()
log('Kinetiq fake controller (FluidNC %s)' % VERSION)
log('  port:    %s -> %s' % (args.link, os.ttyname(slave)))
log('  rc file: %s' % args.rc)
if trace_file is not None:
    log('  trace:   %s' % args.trace)
log('  start Kinetiq with:  KINETIQ_RC=%s npm run dev   (or: npm run dev:fake)' % args.rc)
log('  state:   %s, motion x%g, probe surface at Z%g%s%s' % (
    S['state'], args.speed, args.surface_z, ' (flat)' if args.flat else '',
    ', probe misses' if args.probe_miss else ''))
try:
    reader()
except KeyboardInterrupt:
    pass
finally:
    try:
        os.unlink(args.link)
    except OSError:
        pass
