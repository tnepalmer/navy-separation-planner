#!/usr/bin/env python3
"""Weekly rule watcher for the Navy Separation Planner.

Checks three things and opens one GitHub issue when something needs a human look:
  1. New NAVADMIN messages that mention separation-related topics.
  2. Changes to every official page or PDF the planner links to.
  3. Pages that have stopped loading.

It never edits the planner. State is kept in a JSON file that the workflow stores on
the `watcher-state` branch.

Standard library only. Environment:
  STATE_FILE      path to the state JSON (default: state.json)
  INDEX_FILE      path to the planner page to read links from (default: index.html)
  GITHUB_TOKEN, GITHUB_REPOSITORY   to open the issue (if unset, the report is printed)
  NAVADMIN_BASE   override for testing
"""
import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

UA = 'Mozilla/5.0 (compatible; NavySeparationPlannerWatcher/1.0; +https://github.com/tnepalmer/navy-separation-planner)'
NAVADMIN_BASE = os.environ.get('NAVADMIN_BASE', 'https://www.mynavyhr.navy.mil')
STATE_FILE = os.environ.get('STATE_FILE', 'state.json')
INDEX_FILE = os.environ.get('INDEX_FILE', 'index.html')
SKIP_HOSTS = ('fonts.googleapis.com', 'fonts.gstatic.com', 'github.com', 'workers.dev', 'calendar.google.com', 'safe.apps.mil', 'va.my.site.com')
MAX_NEW_MESSAGES = 60
MISS_LIMIT = 4  # stop probing NAVADMIN numbers after this many misses in a row
BLOCKED = (401, 403, 429)  # the site refuses automated visitors from cloud servers

# Topics that can change the planner. Case-insensitive unless marked.
KEYWORDS = [
    r'separat(?:e|ion|ing|ee)', r'transition assistance', r'\bSkillBridge\b', r'\bEAOS\b', r'terminal leave',
    r'separation leave', r'\bPTDY\b', r'household goods', r'\bHHG\b', r'personally procured move', r'\bTRICARE\b',
    r'\bTAMP\b', r'\bCHCBP\b', r'disability (?:claim|compensation|evaluation)', r'Benefits Delivery at Discharge',
    r'\bDD[- ]?214\b', r'\bDD[- ]?2648\b', r'\bDD[- ]?2656\b', r'Fleet Reserve', r'retirement', r'\bCapstone\b',
    r'career counselor', r'Navy COOL', r'credentialing', r'\bGI Bill\b', r'\bSGLI\b', r'\bVGLI\b', r'\bFSGLI\b',
    r'Survivor Benefit Plan', r'Individual Ready Reserve', r'\bIRR\b', r'separation health', r'\bSHPE\b',
]
CASE_SENSITIVE = [r'\bTAP\b']


def fetch(url, timeout=40):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read(), r.headers.get('Content-Type', '')
        except urllib.error.HTTPError as e:
            return e.code, b'', ''
        except Exception as e:  # network error: retry once
            if attempt == 1:
                return None, str(e).encode(), ''
            time.sleep(3)


def normalize(body, ctype, url):
    """Turn a page into stable text so cosmetic churn doesn't count as a change."""
    if url.lower().endswith('.pdf') or 'pdf' in ctype:
        return body  # PDFs: compare the bytes
    text = body.decode('utf-8', 'replace')
    text = re.sub(r'(?is)<(script|style|noscript|svg|head)\b.*?</\1>', ' ', text)
    text = re.sub(r'(?s)<!--.*?-->', ' ', text)
    text = re.sub(r'(?s)<[^>]+>', ' ', text)
    text = html.unescape(text)
    # Drop things that change on every load: timestamps, session ids, view counters.
    text = re.sub(r'\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?\b', ' ', text)
    text = re.sub(r'\b[0-9a-f]{24,}\b', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text.encode()


def digest(b):
    return hashlib.sha256(b).hexdigest()


def labels_from_index(path):
    src = open(path, encoding='utf-8').read()
    out = {}
    for label, url in re.findall(r"\['([^'\]]{3,90})', '(https://[^']+)'\]", src):
        out.setdefault(url, label)
    for name, url in re.findall(r"nm: '([^']+)'[^}]*?url: '(https://[^']+)'", src):
        out.setdefault(url, name)
    return out


def links_from_index(path):
    src = open(path, encoding='utf-8').read()
    urls = set()
    for u in re.findall(r"https://[^'\"\s)<>]+", src):
        u = u.rstrip('.,')
        host = u.split('/')[2]
        if any(h in host for h in SKIP_HOSTS):
            continue
        urls.add(u)
    return sorted(urls)


# ---------- NAVADMIN ----------
def navadmin_url(year, num, ext):
    return f'{NAVADMIN_BASE}/Portals/55/Messages/NAVADMIN/NAV{year}/NAV{year % 100:02d}{num:03d}.{ext}'


def navadmin_index_numbers(year):
    status, body, _ = fetch(f'{NAVADMIN_BASE}/References/Messages/NAVADMIN-{year}/')
    print(f'  NAVADMIN index {year}: {status if status else "ERR " + body[:80].decode("utf-8", "replace")}')
    if status in BLOCKED:
        return None
    if status != 200:
        return []
    yy = f'{year % 100:02d}'
    return sorted({int(n) for n in re.findall(rf'NAV{yy}(\d{{3}})\.(?:txt|pdf)', body.decode('utf-8', 'replace'), re.I)})


def message_text(year, num):
    for ext in ('txt', 'pdf'):
        status, body, ctype = fetch(navadmin_url(year, num, ext))
        if status == 200 and body:
            if ext == 'pdf':
                # Best effort: pull readable strings out of the PDF without extra libraries.
                raw = body.decode('latin-1', 'replace')
                parts = re.findall(r'\(([^()]{3,})\)', raw)
                return ' '.join(parts) if parts else raw, navadmin_url(year, num, ext)
            return body.decode('utf-8', 'replace'), navadmin_url(year, num, ext)
    return None, None


def subject_of(text):
    m = re.search(r'SUBJ(?:ECT)?\s*/\s*(.+?)(?://|\n)', text, re.I)
    return re.sub(r'\s+', ' ', m.group(1)).strip()[:160] if m else '(no subject line found)'


def topic_hits(text):
    hits = []
    for pat in KEYWORDS:
        for m in re.finditer(pat, text, re.I):
            hits.append(m.group(0).strip())
    for pat in CASE_SENSITIVE:
        for m in re.finditer(pat, text):
            hits.append(m.group(0).strip())
    seen, out = set(), []
    for h in hits:
        k = h.lower()
        if k not in seen:
            seen.add(k)
            out.append(h)
    return out


def check_navadmins(state, today):
    found, notes = [], []
    nav = state.setdefault('navadmin', {})
    for year in sorted({today.year - (1 if today.month == 1 else 0), today.year}):
        key = str(year)
        last = nav.get(key) or None
        listed = navadmin_index_numbers(year)
        if listed is None:
            state['navadmin_blocked'] = True
            nav.pop(key, None)
            notes.append(f'NAVADMIN {year}: site refused the request; skipped.')
            continue
        state['navadmin_blocked'] = False
        if last is None:
            # First run for this year: record where we are without reporting old messages.
            start = max(listed) if listed else 0
            if not listed:
                n, misses = 0, 0
                while misses < MISS_LIMIT and n < 999:
                    n += 1
                    text, _ = message_text(year, n)
                    if text:
                        start, misses = n, 0
                    else:
                        misses += 1
            nav[key] = start
            notes.append(f'NAVADMIN {year}: baseline set at message {start:03d}.')
            continue
        candidates = [n for n in listed if n > last]
        if not candidates:
            n, misses = last, 0
            while misses < MISS_LIMIT and len(candidates) < MAX_NEW_MESSAGES:
                n += 1
                text, _ = message_text(year, n)
                if text:
                    candidates.append(n)
                    misses = 0
                else:
                    misses += 1
        for num in candidates[:MAX_NEW_MESSAGES]:
            text, url = message_text(year, num)
            if not text:
                continue
            hits = topic_hits(text)
            if hits:
                found.append({'id': f'NAVADMIN {num:03d}/{year % 100:02d}', 'url': url, 'subject': subject_of(text), 'hits': hits[:8]})
            nav[key] = max(nav.get(key, 0), num)
    return found, notes


# ---------- linked pages ----------
def check_pages(state, urls, today):
    pages = state.setdefault('pages', {})
    changed, broken, notes = [], [], []
    for url in urls:
        status, body, ctype = fetch(url)
        print(f'  {status if status else "ERR"}  {url}' + ('' if status else f'  ({body[:80].decode("utf-8", "replace")})'))
        rec = pages.get(url)
        if status in BLOCKED:
            pages[url] = {**(rec or {}), 'blocked': True, 'fails': 0}
            continue
        if status != 200 or not body:
            fails = (rec or {}).get('fails', 0) + 1
            pages[url] = {**(rec or {}), 'fails': fails, 'blocked': False}
            gone = status in (404, 410)
            if (gone and fails == 1) or (not gone and fails == 2):  # report once
                broken.append({'url': url, 'status': status or 'no response'})
            continue
        h = digest(normalize(body, ctype, url))
        if rec is None or 'hash' not in rec:
            pages[url] = {'hash': h, 'seen': today.isoformat(), 'fails': 0, 'streak': 0, 'blocked': False}
            continue
        if h != rec['hash']:
            streak = rec.get('streak', 0) + 1
            pages[url] = {'hash': h, 'seen': today.isoformat(), 'fails': 0, 'streak': streak, 'changed': today.isoformat()}
            changed.append({'url': url, 'noisy': streak >= 3})
        else:
            pages[url] = {**rec, 'fails': 0, 'streak': 0, 'blocked': False}
    for url in list(pages):
        if url not in urls:
            del pages[url]
    return changed, broken, notes


# ---------- report ----------
def build_report(navs, changed, broken, first_run, n_pages, manual=None, labels=None, nav_blocked=False, today=None):
    lines = []
    if first_run:
        lines.append(f'The rule watcher is set up. It recorded a starting point for the {n_pages} pages the planner links to. '
                     'From now on it checks every Monday and opens an issue only when something may affect the planner.\n')
    if navs:
        lines.append('## New NAVADMINs that mention separation topics\n')
        for n in navs:
            lines.append(f"- **[{n['id']}]({n['url']})**: {n['subject']}  \n  Mentions: {', '.join(n['hits'])}")
        lines.append('')
    real = [c for c in changed if not c['noisy']]
    noisy = [c for c in changed if c['noisy']]
    if real:
        lines.append('## Linked pages that changed since last week\n')
        lines.append('Open each one and compare it with the planner item that cites it.\n')
        for c in real:
            lines.append(f"- {c['url']}")
        lines.append('')
    if noisy:
        lines.append('<details><summary>Pages that change almost every week (probably cosmetic)</summary>\n')
        for c in noisy:
            lines.append(f"- {c['url']}")
        lines.append('\n</details>\n')
    if broken:
        lines.append('## Linked pages that stopped loading\n')
        lines.append('The planner links to these, but they now return “not found” or have failed two weeks in a row. They may need a new address.\n')
        for b in broken:
            lines.append(f"- {b['url']} (status {b['status']})")
        lines.append('')
    if manual:
        labels = labels or {}
        yr = today.year if today else dt.date.today().year
        lines.append('## Monthly check by hand\n')
        lines.append('These sites refuse automated checks from GitHub’s servers, so they need a quick look from a phone or computer. '
                     'Open each one and confirm it still says what the planner says. Tick each box as you go.\n')
        if nav_blocked:
            lines.append(f'- [ ] [NAVADMIN messages for {yr}](https://www.mynavyhr.navy.mil/References/Messages/NAVADMIN-{yr}/): scan this month’s titles for separation, transition, SkillBridge, TAP, household goods or TRICARE')
        for u in manual:
            lines.append(f'- [ ] [{labels.get(u, u)}]({u})')
        lines.append('')
    if not lines:
        return None
    lines.append('---\nWhen something matters, ask Claude to update the planner. Close this issue once it’s reviewed.')
    return '\n'.join(lines)


def open_issue(title, body):
    token, repo = os.environ.get('GITHUB_TOKEN'), os.environ.get('GITHUB_REPOSITORY')
    if not token or not repo:
        print('--- ISSUE (not posted: no GITHUB_TOKEN) ---\n' + title + '\n\n' + body)
        return
    req = urllib.request.Request(f'https://api.github.com/repos/{repo}/issues', method='POST',
                                 data=json.dumps({'title': title, 'body': body}).encode(),
                                 headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
                                          'User-Agent': UA, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        print('Opened issue', json.loads(r.read())['html_url'])


def main():
    today = dt.date.fromisoformat(os.environ['TODAY']) if os.environ.get('TODAY') else dt.date.today()
    try:
        state = json.load(open(STATE_FILE))
    except Exception:
        state = {}
    first_run = not state
    urls = links_from_index(INDEX_FILE)
    labels = labels_from_index(INDEX_FILE)
    navs, nav_notes = check_navadmins(state, today)
    changed, broken, _ = check_pages(state, urls, today)
    blocked = [u for u in urls if state['pages'].get(u, {}).get('blocked')]
    monthly = today.day <= 7 and state.get('manual_month') != today.strftime('%Y-%m')
    manual = blocked if monthly and (blocked or state.get('navadmin_blocked')) else None
    if manual is not None:
        state['manual_month'] = today.strftime('%Y-%m')
    for n in nav_notes:
        print(n)
    print(f'Checked {len(urls)} pages: {len(changed)} changed, {len(broken)} newly broken. NAVADMIN hits: {len(navs)}.')
    state['last_run'] = today.isoformat()
    json.dump(state, open(STATE_FILE, 'w'), indent=1, sort_keys=True)
    print(f'Blocked by the site (check by hand monthly): {len(blocked)}.')
    body = build_report(navs, changed, broken, first_run, len(urls), manual, labels, state.get('navadmin_blocked'), today)
    if body:
        if first_run and not (navs or changed or broken):
            title = 'Rule watcher is running'
        elif manual is not None and not (navs or changed or broken):
            title = f'Monthly check by hand: {today.strftime("%B %Y")}'
        else:
            title = f'Rule check {today.isoformat()}: {len(navs)} NAVADMIN, {len(changed)} page change(s), {len(broken)} broken link(s)' + (' + monthly check by hand' if manual is not None else '')
        open_issue(title, body)
    else:
        print('Nothing to report.')


if __name__ == '__main__':
    sys.exit(main())
