#!/usr/bin/env python3
"""MZO VM stats sampler: CPU, memory, swap, disk, network, services and processes.

Runs as mzo-stats.service (python3 stdlib only, about 12 MB). Every 5 s it reads /proc, the
systemd cgroups and a few state files, and writes JSON for the stats page (vm/stats/www, served
by Caddy at stats.<ip>.sslip.io and inside the data portal as the Server page):

  now.json    the latest numbers (every 5 s)
  hour.json   5 s points, last hour (every 15 s)
  day.json    1 min points, last 24 hours (every minute)
  week.json   15 min points, last 7 days (every 15 minutes)

into $RUNTIME_DIRECTORY (/run/mzo-stats, tmpfs). History is saved to $STATE_DIRECTORY
(/var/lib/mzo-stats) every 5 minutes and on stop, so a restart keeps the charts.

Only aggregate numbers, unit names and process names are written: no command lines,
environment, paths of user files, IP addresses or logs. The page is public.

  python3 sampler.py            run (the service)
  python3 sampler.py --once     take two samples 5 s apart, print now.json and exit (a check)
"""
import json
import os
import signal
import subprocess
import sys
import time

OUT = os.environ.get('RUNTIME_DIRECTORY', '/run/mzo-stats').split(':')[0]
STATE = os.environ.get('STATE_DIRECTORY', '/var/lib/mzo-stats').split(':')[0]
STEP = 5
HOUR, DAY, WEEK = 3600, 86400, 7 * 86400
CG = '/sys/fs/cgroup/system.slice'
MB = 1024 * 1024

# key, unit, label: the services shown on the page (memory by service is charted for these four).
SERVICES = [
    ('app', 'mzo-reports.service', 'App (MZO Reports)'),
    ('pb', 'pocketbase.service', 'PocketBase'),
    ('caddy', 'caddy.service', 'Caddy (web)'),
    ('sync', 'mzo-sync.service', 'Data sync'),
    ('deploy', 'mzo-deploy.service', 'Auto deploy'),
    ('stats', 'mzo-stats.service', 'Stats sampler'),
]
CHARTED = ('app', 'pb', 'caddy', 'sync')
# label, path: what uses the disk (sizes every 15 minutes).
DIRS = [
    ('PocketBase data', '/opt/mzo/pocketbase/pb_data'),
    ('Snapshots', '/opt/mzo/data/snapshots'),
    ('App releases', '/opt/mzo/releases'),
    ('Node packages', '/opt/mzo/deps'),
    ('System logs', '/var/log'),
]
FS_TYPES = ('xfs', 'ext4', 'ext3', 'btrfs', 'vfat')
# History columns. Rates are KB/s, memory MB, CPU % of the whole machine.
COLS = ['t', 'cpu', 'iow', 'st', 'l1', 'mu', 'mc', 'sw', 'rx', 'tx', 'dr', 'dw'] + \
       ['m_' + k for k in CHARTED] + ['c_' + k for k in CHARTED]
CLK = os.sysconf('SC_CLK_TCK')
NCPU = os.cpu_count() or 1
PAGE = os.sysconf('SC_PAGE_SIZE')


def read(path, default=''):
    try:
        with open(path, 'r') as f:
            return f.read()
    except OSError:
        return default


def write_json(name, obj):
    path = os.path.join(OUT, name)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, separators=(',', ':'))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def r1(v):
    return None if v is None else round(v, 1)


# ---------- raw counters ----------

def cpu_times():
    parts = read('/proc/stat').split('\n', 1)[0].split()
    v = [int(x) for x in parts[1:9]] + [0] * 8
    user, nice, system, idle, iowait, irq, softirq, steal = v[:8]
    return {'total': user + nice + system + idle + iowait + irq + softirq + steal,
            'idle': idle, 'iowait': iowait, 'steal': steal}


def meminfo():
    m = {}
    for line in read('/proc/meminfo').splitlines():
        k, _, rest = line.partition(':')
        try:
            m[k] = int(rest.split()[0]) * 1024
        except (ValueError, IndexError):
            pass
    total, avail = m.get('MemTotal', 0), m.get('MemAvailable', m.get('MemFree', 0))
    cache = m.get('Buffers', 0) + m.get('Cached', 0) + m.get('SReclaimable', 0) - m.get('Shmem', 0)
    return {'total': total, 'avail': avail, 'used': total - avail, 'free': m.get('MemFree', 0),
            'cache': max(0, cache), 'swapTotal': m.get('SwapTotal', 0),
            'swapUsed': m.get('SwapTotal', 0) - m.get('SwapFree', 0)}


def vmstat():
    out = {}
    for line in read('/proc/vmstat').splitlines():
        k, _, v = line.partition(' ')
        if k in ('oom_kill', 'pswpin', 'pswpout'):
            out[k] = int(v)
    return out


def net_bytes():
    rx = tx = 0
    for line in read('/proc/net/dev').splitlines()[2:]:
        name, _, rest = line.partition(':')
        name = name.strip()
        if name == 'lo' or not rest:
            continue
        f = rest.split()
        rx += int(f[0])
        tx += int(f[8])
    return rx, tx


def disks():
    names = [d for d in os.listdir('/sys/block') if not d.startswith(('loop', 'ram', 'dm-', 'zram', 'sr'))]
    return names


DISKS = disks()


def disk_counters():
    rd = wr = busy = 0
    for line in read('/proc/diskstats').splitlines():
        f = line.split()
        if len(f) > 12 and f[2] in DISKS:
            rd += int(f[5]) * 512
            wr += int(f[9]) * 512
            busy = max(busy, int(f[12]))
    return rd, wr, busy


def cgroup(unit):
    base = os.path.join(CG, unit)
    if not os.path.isdir(base):
        return None
    stat = {}
    for line in read(os.path.join(base, 'memory.stat')).splitlines():
        k, _, v = line.partition(' ')
        if k in ('anon', 'file', 'kernel', 'shmem'):
            stat[k] = int(v)
    usec = 0
    for line in read(os.path.join(base, 'cpu.stat')).splitlines():
        if line.startswith('usage_usec '):
            usec = int(line.split()[1])
    cur = read(os.path.join(base, 'memory.current')).strip()
    return {'anon': stat.get('anon', 0) + stat.get('kernel', 0) + stat.get('shmem', 0),
            'file': stat.get('file', 0), 'current': int(cur) if cur.isdigit() else 0, 'usec': usec}


def processes():
    """{pid: (name, rss bytes, cpu ticks)} for every process (comm only, never the command line)."""
    out = {}
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        s = read('/proc/%s/stat' % pid)
        if not s:
            continue
        lp, rp = s.find('('), s.rfind(')')
        name = s[lp + 1:rp]
        f = s[rp + 2:].split()
        try:
            ticks = int(f[11]) + int(f[12])
            rss = int(f[21]) * PAGE
        except (IndexError, ValueError):
            continue
        if rss:
            out[pid] = (name, rss, ticks)
    return out


# ---------- slower facts ----------

def host_info():
    osname = ''
    for line in read('/etc/os-release').splitlines():
        if line.startswith('PRETTY_NAME='):
            osname = line.split('=', 1)[1].strip().strip('"')
    model = ''
    for line in read('/proc/cpuinfo').splitlines():
        if line.startswith('model name'):
            model = ' '.join(line.split(':', 1)[1].split())
            break
    up = float(read('/proc/uptime', '0 0').split()[0])
    return {'os': osname, 'kernel': os.uname().release, 'cpuModel': model, 'cores': NCPU,
            'bootTime': int(time.time() - up)}


def filesystems():
    seen, out = set(), []
    for line in read('/proc/self/mounts').splitlines():
        f = line.split()
        if len(f) < 3 or f[2] not in FS_TYPES or f[0] in seen:
            continue
        seen.add(f[0])
        try:
            st = os.statvfs(f[1])
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        if not total:
            continue
        out.append({'mount': f[1], 'type': f[2], 'total': total,
                    'used': (st.f_blocks - st.f_bfree) * st.f_frsize, 'avail': st.f_bavail * st.f_frsize})
    out.sort(key=lambda x: (x['mount'] != '/', x['mount']))
    return out


def swap_files():
    out = []
    for line in read('/proc/swaps').splitlines()[1:]:
        f = line.split()
        if len(f) >= 4:
            out.append({'size': int(f[2]) * 1024, 'used': int(f[3]) * 1024})
    return out


def dir_size(path):
    total = 0
    for root, dirs, files in os.walk(path, onerror=lambda e: None):
        for name in files:
            try:
                st = os.lstat(os.path.join(root, name))
                total += st.st_blocks * 512
            except OSError:
                pass
    return total


def dir_sizes():
    out = []
    for label, path in DIRS:
        if os.path.isdir(path):
            out.append({'label': label, 'bytes': dir_size(path)})
    return out


def unit_states():
    units = [u for _, u, _ in SERVICES]
    try:
        txt = subprocess.run(
            ['systemctl', 'show', '--timestamp=unix', '-p',
             'Id,ActiveState,SubState,Result,NRestarts,ActiveEnterTimestamp,ExecMainStartTimestamp,ExecMainExitTimestamp'] + units,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, universal_newlines=True).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    out = {}
    for block in txt.strip().split('\n\n'):
        d = {}
        for line in block.splitlines():
            k, _, v = line.partition('=')
            d[k] = v
        if d.get('Id'):
            out[d['Id']] = d
    return out


def ts(v):
    v = (v or '').strip()
    if v.startswith('@'):
        try:
            return int(v[1:])
        except ValueError:
            return None
    return None


def deploy_record():
    try:
        d = json.loads(read('/opt/mzo/state/deployed.json', '{}') or '{}')
    except ValueError:
        return None
    return {'commit': (d.get('commit') or '')[:7], 'version': d.get('version'),
            'at': d.get('deployedAt'), 'status': d.get('status')}


def mtime(path):
    try:
        return int(os.stat(path).st_mtime)
    except OSError:
        return None


# ---------- history ----------

class Series:
    """Column store with a fixed time window."""

    def __init__(self, window, step):
        self.window, self.step = window, step
        self.cols = {c: [] for c in COLS}

    def push(self, point):
        for c in COLS:
            self.cols[c].append(point.get(c))
        cut = point['t'] - self.window
        n = 0
        ts_ = self.cols['t']
        while n < len(ts_) and ts_[n] <= cut:
            n += 1
        if n:
            for c in COLS:
                del self.cols[c][:n]

    def dump(self):
        d = {'step': self.step, 'window': self.window, 'cols': COLS}
        d.update(self.cols)
        return d

    def load(self, d, now):
        if not isinstance(d, dict) or not isinstance(d.get('t'), list):
            return
        keep = [i for i, t in enumerate(d['t']) if isinstance(t, (int, float)) and now - self.window < t <= now]
        for c in COLS:
            src = d.get(c) or []
            self.cols[c] = [src[i] if i < len(src) else None for i in keep]


def average(points, t):
    out = {'t': t}
    for c in COLS[1:]:
        vals = [p[c] for p in points if p.get(c) is not None]
        out[c] = r1(sum(vals) / len(vals)) if vals else None
    return out


# ---------- the sampler ----------

class Sampler:
    def __init__(self):
        self.prev = None
        self.procs_prev = {}
        self.hour = Series(HOUR, STEP)
        self.day = Series(DAY, 60)
        self.week = Series(WEEK, 900)
        self.minute, self.quarter = [], []
        self.host = host_info()
        self.fs, self.swaps, self.dirs, self.dirs_at = [], [], [], None
        self.units, self.deploy = {}, None
        self.next = {'fs': 0, 'dirs': 0, 'units': 0, 'hour': 0, 'save': time.time() + 300}
        self.latest = None

    def counters(self):
        return {'mono': time.monotonic(), 'cpu': cpu_times(), 'net': net_bytes(), 'disk': disk_counters(),
                'vm': vmstat(), 'cg': {k: cgroup(u) for k, u, _ in SERVICES}}

    def sample(self):
        now = time.time()
        cur = self.counters()
        prev, self.prev = self.prev, cur
        procs = processes()
        procs_prev, self.procs_prev = self.procs_prev, procs
        if prev is None:
            return None
        dt = max(0.5, cur['mono'] - prev['mono'])
        c0, c1 = prev['cpu'], cur['cpu']
        dtot = max(1, c1['total'] - c0['total'])
        pct = lambda k: 100.0 * (c1[k] - c0[k]) / dtot
        cpu = 100.0 - pct('idle') - pct('iowait')
        mem = meminfo()
        rx = (cur['net'][0] - prev['net'][0]) / dt / 1024
        tx = (cur['net'][1] - prev['net'][1]) / dt / 1024
        dr = (cur['disk'][0] - prev['disk'][0]) / dt / 1024
        dw = (cur['disk'][1] - prev['disk'][1]) / dt / 1024
        busy = min(100.0, (cur['disk'][2] - prev['disk'][2]) / (dt * 10.0))
        load = [float(x) for x in read('/proc/loadavg', '0 0 0').split()[:3]]
        point = {'t': int(now), 'cpu': r1(max(0.0, cpu)), 'iow': r1(pct('iowait')), 'st': r1(pct('steal')),
                 'l1': round(load[0], 2), 'mu': r1(mem['used'] / MB), 'mc': r1(mem['cache'] / MB),
                 'sw': r1(mem['swapUsed'] / MB), 'rx': r1(rx), 'tx': r1(tx), 'dr': r1(dr), 'dw': r1(dw)}
        services_now = {}
        for key, unit, _ in SERVICES:
            a, b = prev['cg'].get(key), cur['cg'].get(key)
            cpu_s = None
            if a and b and b['usec'] >= a['usec']:
                cpu_s = 100.0 * (b['usec'] - a['usec']) / (dt * 1e6 * NCPU)
            services_now[key] = {'mem': r1(b['anon'] / MB) if b else None, 'cache': r1(b['file'] / MB) if b else None,
                                 'cpu': r1(cpu_s) if b else None}
            if key in CHARTED:
                point['m_' + key] = services_now[key]['mem'] if b else 0
                point['c_' + key] = services_now[key]['cpu'] if b else 0
        # Top processes by memory, with CPU over the last step (process names only).
        rows = []
        for pid, (name, rss, ticks) in procs.items():
            old = procs_prev.get(pid)
            cpu_p = 100.0 * (ticks - old[2]) / CLK / dt / NCPU if old and old[0] == name and ticks >= old[2] else None
            rows.append((rss, name, cpu_p))
        rows.sort(reverse=True)
        top = [{'name': n, 'mem': r1(rss / MB), 'cpu': r1(c)} for rss, n, c in rows[:8]]
        vm0, vm1 = prev['vm'], cur['vm']
        self.latest = {
            'v': 1, 't': int(now), 'step': STEP, 'host': self.host,
            'uptime': int(now - self.host['bootTime']),
            'cpu': {'pct': point['cpu'], 'iowait': point['iow'], 'steal': point['st'], 'load': load, 'cores': NCPU},
            'mem': {k: r1(v / MB) for k, v in mem.items()},
            'swapFiles': [{'size': r1(s['size'] / MB), 'used': r1(s['used'] / MB)} for s in self.swaps],
            'swapIO': {'in': r1((vm1.get('pswpin', 0) - vm0.get('pswpin', 0)) / dt),
                       'out': r1((vm1.get('pswpout', 0) - vm0.get('pswpout', 0)) / dt)},
            'oomKills': vm1.get('oom_kill', 0),
            'net': {'rx': point['rx'], 'tx': point['tx']},
            'disk': {'read': point['dr'], 'write': point['dw'], 'busy': r1(busy)},
            'fs': self.fs, 'dirs': self.dirs, 'dirsAt': self.dirs_at,
            'services': self.service_rows(services_now),
            'procs': {'count': len(procs), 'top': top},
            'deploy': self.deploy,
            'syncAt': mtime('/opt/mzo/data/snapshots/manifest.json'),
            'point': point,
        }
        return point

    def service_rows(self, now_vals):
        out = []
        for key, unit, label in SERVICES:
            d = self.units.get(unit, {})
            row = {'key': key, 'unit': unit, 'label': label, 'state': d.get('ActiveState') or 'unknown',
                   'sub': d.get('SubState') or '', 'result': d.get('Result') or '',
                   'restarts': int(d['NRestarts']) if (d.get('NRestarts') or '').isdigit() else None,
                   'since': ts(d.get('ActiveEnterTimestamp')), 'lastStart': ts(d.get('ExecMainStartTimestamp')),
                   'lastExit': ts(d.get('ExecMainExitTimestamp'))}
            row.update(now_vals.get(key) or {})
            out.append(row)
        return out

    def slow(self, now):
        if now >= self.next['units']:
            self.units = unit_states()
            self.deploy = deploy_record()
            self.next['units'] = now + 15
        if now >= self.next['fs']:
            self.fs, self.swaps = filesystems(), swap_files()
            self.next['fs'] = now + 60
        if now >= self.next['dirs']:
            self.dirs, self.dirs_at = dir_sizes(), int(time.time())
            self.next['dirs'] = now + 900

    def roll(self, point):
        """5 s point -> hour; a finished minute -> day; a finished quarter hour -> week."""
        self.hour.push(point)
        t = point['t']
        if self.minute and t // 60 != self.minute[0]['t'] // 60:
            m = average(self.minute, self.minute[0]['t'] // 60 * 60)
            self.minute = []
            self.day.push(m)
            write_json('day.json', self.day.dump())
            if self.quarter and m['t'] // 900 != self.quarter[0]['t'] // 900:
                q = average(self.quarter, self.quarter[0]['t'] // 900 * 900)
                self.quarter = []
                self.week.push(q)
                write_json('week.json', self.week.dump())
            self.quarter.append(m)
        self.minute.append(point)

    def save(self):
        try:
            os.makedirs(STATE, exist_ok=True)
            tmp = os.path.join(STATE, 'history.json.tmp')
            with open(tmp, 'w') as f:
                json.dump({'v': 1, 'hour': self.hour.dump(), 'day': self.day.dump(), 'week': self.week.dump()}, f,
                          separators=(',', ':'))
            os.replace(tmp, os.path.join(STATE, 'history.json'))
        except OSError as e:
            print('history not saved: %s' % e, file=sys.stderr)

    def restore(self):
        try:
            with open(os.path.join(STATE, 'history.json')) as f:
                d = json.load(f)
        except (OSError, ValueError):
            return
        now = time.time()
        self.hour.load(d.get('hour'), now)
        self.day.load(d.get('day'), now)
        self.week.load(d.get('week'), now)

    def write_all(self):
        write_json('hour.json', self.hour.dump())
        write_json('day.json', self.day.dump())
        write_json('week.json', self.week.dump())

    def run(self):
        os.makedirs(OUT, exist_ok=True)
        self.restore()
        self.slow(time.time())
        self.sample()
        self.write_all()
        stop = []
        signal.signal(signal.SIGTERM, lambda *a: stop.append(1))
        signal.signal(signal.SIGINT, lambda *a: stop.append(1))
        tick = time.monotonic()
        while not stop:
            tick += STEP
            delay = tick - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            else:
                tick = time.monotonic()
            if stop:
                break
            now = time.time()
            try:
                self.slow(now)
                point = self.sample()
                if point:
                    self.roll(point)
                    write_json('now.json', self.latest)
                    if now >= self.next['hour']:
                        write_json('hour.json', self.hour.dump())
                        self.next['hour'] = now + 15
                if now >= self.next['save']:
                    self.save()
                    self.next['save'] = now + 300
            except Exception as e:  # keep sampling; one bad read must not stop the page
                print('sample failed: %r' % (e,), file=sys.stderr)
        self.save()


def main():
    if '--once' in sys.argv:
        s = Sampler()
        s.slow(time.time())
        s.sample()
        time.sleep(STEP)
        s.sample()
        print(json.dumps(s.latest, indent=1))
        return
    Sampler().run()


if __name__ == '__main__':
    main()
