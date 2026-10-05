"""Build gmail_index.json from exported Gmail sent-thread pages (pages/p*.txt).

Each line: <thread_id> J <date> <recipient>|S <sender>|B <bounced address>...
"""
import glob, json, re
import os, sys
# Bounced addresses found in Gmail delivery-failure notices, one per line (kept out of git).
failed = open('bounced.txt').read().split() if os.path.exists('bounced.txt') else []
ME = os.environ.get('CRM_OWNER_EMAIL', '').lower()
def norm(a):
    a = a.strip().lower()
    l, _, d = a.partition('@')
    if d in ('gmail.com', 'googlemail.com'):
        l = l.split('+')[0].replace('.', ''); d = 'gmail.com'
    return l + '@' + d
sent = {}; senders = set(); bounced = set(norm(x) for x in failed); threads = 0
for f in sorted(glob.glob('pages/p*.txt')):
    for line in open(f):
        line = line.strip()
        if not line: continue
        threads += 1
        tid, _, rest = line.partition(' ')
        for item in rest.split('|'):
            p = item.split()
            if p[0] == 'J':
                a = norm(p[2])
                if a == ME: continue
                if a not in sent or p[1] > sent[a]: sent[a] = p[1]
            elif p[0] == 'S': senders.add(norm(p[1]))
            elif p[0] == 'B': bounced.add(norm(p[1]))
idx = {}
for a, d in sent.items():
    idx[a] = {"sent": True, "last_sent": d, "replied": a in senders, "bounced": a in bounced}
for a in bounced:
    if a not in idx and a != ME:
        idx[a] = {"sent": False, "last_sent": None, "replied": a in senders, "bounced": True}
json.dump(dict(sorted(idx.items())), open('gmail_index.json', 'w'), indent=1)
print('threads', threads, 'addresses', len(idx), 'sent', len(sent),
      'replied', sum(v['replied'] for v in idx.values()), 'bounced', sum(v['bounced'] for v in idx.values()))
print('bounced not in sent:', sorted(a for a in bounced if a not in sent))
dl = [norm(x) for x in delay_only]
print('delay-only in sent:', sum(a in sent for a in dl), 'of', len(dl))
print('bounced but replied:', sorted(a for a in idx if idx[a]['bounced'] and idx[a]['replied']))
