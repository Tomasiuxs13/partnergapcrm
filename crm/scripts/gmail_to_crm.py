"""Turn gmail_index.json into new Accounts and Contacts rows (gm_rows.json) for the CRM sheet."""
import json,re,collections
# accounts_domains.json: get_values of Accounts!B2:B; contacts_emails.json: get_values of Contacts!G2:G
acc=json.load(open('accounts_domains.json'))['values']
con=json.load(open('contacts_emails.json'))['values']
g=json.load(open('gmail_index.json'))
def norm(e):
    e=e.strip().lower()
    l,_,d=e.partition('@')
    if d in('gmail.com','googlemail.com'): l=l.split('+')[0].replace('.','');d='gmail.com'
    return l+'@'+d
existing_emails={norm(r[0]) for r in con if r and r[0]}
dom2id={}
for i,r in enumerate(acc):
    if r and r[0]:
        d=r[0].strip().lower()
        dom2id.setdefault(d,'PG-%05d'%(i+1))
FREE=set('gmail.com googlemail.com yahoo.com hotmail.com outlook.com live.com icloud.com me.com aol.com protonmail.com proton.me mail.com gmx.com gmx.de yandex.com yandex.ru hotmail.co.uk yahoo.co.uk msn.com zoho.com mail.ru qq.com 163.com web.de outlook.de hotmail.fr yahoo.fr libero.it seznam.cz wp.pl o2.pl interia.pl rediffmail.com ymail.com rocketmail.com inbox.lv inbox.lt tutanota.com pm.me hey.com fastmail.com t-online.de naver.com'.split())
skip_re=re.compile(r'(noreply|no-reply|donotreply|mailer-daemon|postmaster)')
rows=[];skipped=collections.Counter()
for e,v in g.items():
    e0=e.strip().lower(); dom=e0.split('@')[-1]
    if 'hubspot.com' in dom: skipped['hubspot']+=1;continue
    if dom.endswith('partnergap.com'): skipped['pg']+=1;continue
    if skip_re.search(e0.split('@')[0]): skipped['noreply']+=1;continue
    if norm(e0) in existing_emails: skipped['already']+=1;continue
    rows.append((e0,dom,v))
print(len(rows),skipped)
# accounts
newacc=collections.OrderedDict(); nid=4359; reuse=collections.Counter()
def root(d):
    parts=d.split('.')
    if len(parts)>2 and '.'.join(parts[-2:]) in('co.uk','com.au','co.nz','com.br','co.za','co.in','com.mx','co.jp','org.uk'):
        return '.'.join(parts[-3:])
    return '.'.join(parts[-2:])
contacts=[];cid=2720
accinfo=collections.defaultdict(lambda:{'replied':False,'last':''})
for e,dom,v in sorted(rows,key=lambda x:(x[1],x[0])):
    if dom in FREE:
        key=('free',e); d=''
    else:
        d=root(dom); key=d
    if key in newacc: aid=newacc[key]['id']
    elif d and d in dom2id: aid=dom2id[d]; reuse[aid]+=1
    else:
        aid='PG-%05d'%nid; nid+=1
        newacc[key]={'id':aid,'domain':d,'brand':e if not d else d}
    ai=accinfo[aid]; ai['replied']|=v['replied']; ai['last']=max(ai['last'],v.get('last_sent') or '')
    status='Replied' if v['replied'] else ('Bounced' if v['bounced'] else 'Sent')
    estat='Bounced' if v['bounced'] else ('Verified' if v['replied'] else 'Delivered')
    contacts.append(['C-%05d'%cid,aid,None,'','','',e,estat,'','Gmail outreach','',False,status,'',v.get('last_sent') or '',bool(v['replied']),''])
    cid+=1
accrows=[]
for k,a in newacc.items():
    ai=accinfo[a['id']]
    accrows.append([a['id'],a['domain'],a['brand'],'Uncategorized','','Gmail outreach','','','','Jonas','','',
      'Replied' if ai['replied'] else 'Contacted','','','',ai['last'],'','',
      'Free email address, from Jonas\'s Gmail outreach' if not a['domain'] else 'From Jonas\'s Gmail outreach','',''])
print('new accounts',len(accrows),'reused accounts',len(reuse),'contacts',len(contacts),'next PG',nid,'next C',cid)
print('free-mail accounts',sum(1 for k in newacc if isinstance(k,tuple)))
json.dump({'acc':accrows,'con':contacts,'reuse':{k:accinfo[k] for k in reuse}},open('gm_rows.json','w'))
print(collections.Counter(c[12] for c in contacts))
