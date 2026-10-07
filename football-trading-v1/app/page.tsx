'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import MatchCard from '../components/MatchCard';
import { evaluateV1 } from '../lib/rules';
import { League, TradingMatch } from '../lib/types';

const leagues: Array<'ALL' | League> = ['ALL', 'MLS', 'Allsvenskan', 'Liga MX', 'Brazil Serie A'];
type View = 'SCANNER' | 'STARRED' | 'HISTORY';

const STAR_KEY = 'football-trading-v1-starred';
const HISTORY_KEY = 'football-trading-v1-history';

function readSaved(key: string): TradingMatch[] {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
}

function nextCheckpoint(match: TradingMatch) {
  if (!match.kickoff) return 'Checkpoint';
  const kickoff = new Date(match.kickoff).getTime();
  const now = Date.now();
  const min = (now - kickoff) / 60000;

  if (min < 38) return `40' check in ${Math.max(1, Math.ceil(38 - min))}m`;
  if (min < 48) return "40' CHECK DUE";
  if (min < 60) return 'HT CHECK DUE';
  if (min < 105) return 'H2 checkpoint';
  return 'Check result';
}

export default function Home() {
  const [matches, setMatches] = useState<TradingMatch[]>([]);
  const [starred, setStarred] = useState<TradingMatch[]>([]);
  const [history, setHistory] = useState<TradingMatch[]>([]);
  const [league, setLeague] = useState<'ALL' | League>('ALL');
  const [view, setView] = useState<View>('SCANNER');
  const [checkpoint, setCheckpoint] = useState<TradingMatch | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [providerStatus, setProviderStatus] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const [nextRefreshAt, setNextRefreshAt] = useState('');
  const [scanStatus, setScanStatus] = useState('');
  const [scanCoverage, setScanCoverage] = useState('');
  const [budgetStatus, setBudgetStatus] = useState('');
  const [htLoadingId, setHtLoadingId] = useState<string | null>(null);

  useEffect(() => {
    setStarred(readSaved(STAR_KEY));
    setHistory(readSaved(HISTORY_KEY));
    loadCachedScan();
  }, []);

  async function loadCachedScan() {
    try {
      const res = await fetch('/api/gpt-scan', { cache: 'no-store' });
      const data = await res.json();
      const incoming = (data.matches ?? []) as TradingMatch[];

      setMatches(incoming);
      setProviderStatus(data.providerStatus ?? data.mode ?? '');
      setUpdatedAt(data.updatedAt ?? '');
      setNextRefreshAt(data.nextRefreshAt ?? '');
      setScanStatus(data.scanStatus ?? '');
      setScanCoverage(data.fixturesFound != null
        ? `${data.fixturesVerified ?? 0}/${data.fixturesFound} fixtures verified`
        : '');
      setBudgetStatus(data.budgetMessage ?? (data.estimatedCostUsd != null
        ? `This scan est. ${Number(data.estimatedCostUsd).toFixed(3)}`
        : ''));

      if (incoming.length) {
        setStarred(prev => {
          const merged = new Map<string, TradingMatch>();
          for (const m of prev) merged.set(m.id, m);
          for (const m of incoming.filter(m => m.state === 'QUALIFIED')) merged.set(m.id, m);
          const next = Array.from(merged.values()).sort(
            (a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime()
          );
          localStorage.setItem(STAR_KEY, JSON.stringify(next));
          return next;
        });
      }
    } catch {
      // Opening the app must never trigger a paid scan or block the UI.
    }
  }

  function saveStarred(next: TradingMatch[]) {
    setStarred(next);
    localStorage.setItem(STAR_KEY, JSON.stringify(next));
  }

  function saveHistory(next: TradingMatch[]) {
    const deduped = Array.from(
      new Map(next.map(m => [`${m.id}-${m.checkedAt ?? m.status}-${m.state}`, m])).values()
    ).slice(0, 150);
    setHistory(deduped);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(deduped));
  }

  function mergeStarred(incoming: TradingMatch[], current: TradingMatch[]) {
    const autoPicks = incoming.filter(m => m.state === 'QUALIFIED');
    const merged = new Map<string, TradingMatch>();

    for (const m of current) merged.set(m.id, m);
    for (const m of autoPicks) merged.set(m.id, m);

    const next = Array.from(merged.values()).sort(
      (a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime()
    );

    saveStarred(next);
  }

  async function scanUpcoming() {
    setLoading(true);
    try {
      let data: any;

      try {
        const res = await fetch('/api/gpt-scan?scan=1', { cache: 'no-store' });
        const text = await res.text();
        data = JSON.parse(text);
      } catch {
        // A mobile browser/network can drop a long response even after the server
        // finished the paid scan. Recover from the shared persistent cache first,
        // so retrying never starts a second paid scan.
        await new Promise(resolve => setTimeout(resolve, 1200));
        const recovery = await fetch('/api/gpt-scan', { cache: 'no-store' });
        const recoveryText = await recovery.text();
        data = JSON.parse(recoveryText);
      }

      const incoming = (data.matches ?? []) as TradingMatch[];

      setMatches(incoming);
      setProviderStatus(data.providerStatus ?? data.mode ?? '');
      setUpdatedAt(data.updatedAt ?? '');
      setNextRefreshAt(data.nextRefreshAt ?? '');
      setScanStatus(data.scanStatus ?? '');
      setScanCoverage(data.fixturesFound != null
        ? `${data.fixturesVerified ?? 0}/${data.fixturesFound} fixtures verified`
        : '');
      setBudgetStatus(data.budgetMessage ?? '');

      if (incoming.length) {
        setStarred(prev => {
          const autoPicks = incoming.filter(m => m.state === 'QUALIFIED');
          const merged = new Map<string, TradingMatch>();
          for (const m of prev) merged.set(m.id, m);
          for (const m of autoPicks) merged.set(m.id, m);
          const next = Array.from(merged.values()).sort(
            (a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime()
          );
          localStorage.setItem(STAR_KEY, JSON.stringify(next));
          return next;
        });

        if (data.providerStatus === 'DAILY_BUDGET_REACHED') {
          setNotice(`Daily budget reached · showing saved result · ${incoming.length} V1 matches`);
        } else if (data.cacheStatus === 'HIT') {
          setNotice(`Shared result · ${incoming.length} qualified V1 matches · no new GPT cost`);
        } else {
          const coverage = data.fixturesFound != null
            ? ` · ${data.fixturesVerified ?? 0}/${data.fixturesFound} fixtures verified`
            : '';
          const partial = data.scanStatus === 'PARTIAL' ? ' · PARTIAL' : ' · COMPLETE';
          setNotice(`New GPT scan${partial}${coverage} · ${incoming.length} qualified`);
        }
      } else {
        const status = data.providerStatus ?? data.mode ?? '';
        setNotice(status === 'OPENAI_API_KEY_MISSING'
          ? 'GPT scanner is ready, but OPENAI_API_KEY is not connected yet.'
          : status === 'DAILY_BUDGET_REACHED'
            ? 'Daily scan budget reached. No paid scan was started.'
            : status === 'ERROR'
              ? `Scan failed safely · ${data.providerError ?? 'scanner error'}`
              : data.scanStatus === 'PARTIAL'
                ? `PARTIAL scan · ${data.fixturesVerified ?? 0}/${data.fixturesFound ?? 0} fixtures verified · no qualifying match verified yet.`
                : 'Scan complete · no verified V1 matches found.');
      }
    } catch {
      setProviderStatus('ERROR');
      setNotice('Pre-match scan failed. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function runHtCheck(match: TradingMatch) {
    setHtLoadingId(match.id);
    setNotice(`GPT is checking HT · ${match.home} vs ${match.away}`);
    try {
      const res = await fetch('/api/ht-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(match),
      });
      const data = await res.json();

      if (data.providerStatus === 'OPENAI_API_KEY_MISSING') {
        setNotice('HT Check is ready, but OPENAI_API_KEY is not connected yet.');
        return;
      }
      if (data.providerStatus !== 'CONNECTED') {
        setNotice(data.advice || 'HT Check failed. Try again.');
        return;
      }

      const updated: TradingMatch = {
        ...match,
        status: 'HT',
        scoreHome: data.scoreHome ?? match.scoreHome,
        scoreAway: data.scoreAway ?? match.scoreAway,
        cornersHome: data.cornersHome ?? match.cornersHome,
        cornersAway: data.cornersAway ?? match.cornersAway,
        liveGoalLine: data.liveGoalLine ?? null,
        liveCornerLine: data.liveCornerLine ?? null,
        favouriteCoveringHandicap: data.favouriteCoveringHandicap ?? false,
        favouriteLosing: data.favouriteLosing ?? false,
        ftGoalOverClear: data.ftGoalOverClear ?? false,
        htAction: data.action,
        htAdvice: data.reason,
        htConfidence: data.confidence,
        htMissingInputs: Array.isArray(data.missingInputs) ? data.missingInputs : [],
        htSourceSummary: data.sourceSummary,
        htSourceUrls: Array.isArray(data.sourceUrls) ? data.sourceUrls : [],
        htCheckedAt: data.checkedAt ?? new Date().toISOString(),
        checkedAt: data.checkedAt ?? new Date().toISOString(),
      };

      setMatches(prev => prev.map(m => m.id === updated.id ? updated : m));
      setStarred(prev => {
        const next = prev.map(m => m.id === updated.id ? updated : m);
        localStorage.setItem(STAR_KEY, JSON.stringify(next));
        return next;
      });
      saveHistory([updated, ...history]);
      setNotice(`HT Check · ${String(data.action).replace(/_/g, ' ')}`);
    } catch {
      setNotice('HT Check failed. Try again.');
    } finally {
      setHtLoadingId(null);
    }
  }

  function toggleStar(match: TradingMatch) {
    const exists = starred.some(m => m.id === match.id);
    saveStarred(exists ? starred.filter(m => m.id !== match.id) : [{ ...match }, ...starred]);
  }

  function submitCheckpoint(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!checkpoint) return;
    const fd = new FormData(e.currentTarget);

    const updated: TradingMatch = {
      ...checkpoint,
      status: String(fd.get('status')) as TradingMatch['status'],
      minute: Number(fd.get('minute')) || null,
      scoreHome: Number(fd.get('scoreHome')) || 0,
      scoreAway: Number(fd.get('scoreAway')) || 0,
      cornersHome: Number(fd.get('cornersHome')) || 0,
      cornersAway: Number(fd.get('cornersAway')) || 0,
      liveCornerLine: fd.get('liveCornerLine') ? Number(fd.get('liveCornerLine')) : null,
      liveGoalLine: fd.get('liveGoalLine') ? Number(fd.get('liveGoalLine')) : null,
      favouriteCoveringHandicap: fd.get('favCovering') === 'on',
      favouriteLosing: fd.get('favLosing') === 'on',
      ftGoalOverClear: fd.get('goalClear') === 'on',
      checkedAt: new Date().toISOString(),
    };

    const evaluated = { ...updated, ...evaluateV1(updated) };
    setMatches(matches.map(m => m.id === evaluated.id ? evaluated : m));
    saveStarred(starred.map(m => m.id === evaluated.id ? evaluated : m));
    saveHistory([evaluated, ...history]);

    if (evaluated.state === 'TRIGGER' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`V1 TRIGGER — ${evaluated.home} vs ${evaluated.away}`, {
        body: `${evaluated.status} | ${evaluated.scoreHome}-${evaluated.scoreAway} | Corners ${evaluated.cornersHome}-${evaluated.cornersAway} | V1 ${evaluated.winProbability}%`,
      });
    }

    setNotice(`${evaluated.state} · V1 ${evaluated.winProbability}%`);
    setCheckpoint(null);
  }

  async function enableNotifications() {
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

    if (!('Notification' in window)) {
      setNotice(isIos
        ? 'iPhone alerts require the app to be added to Home Screen first.'
        : 'This browser does not support notifications.');
      return;
    }

    if (isIos && !isStandalone) {
      setNotice('On iPhone: Share → Add to Home Screen, then open the installed app and tap Alerts again.');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setNotice('Alerts permission enabled on this device.');
    } else if (permission === 'denied') {
      setNotice('Alerts are blocked in device/browser settings.');
    } else {
      setNotice('Alerts permission was not enabled.');
    }
  }

  const source = view === 'STARRED' ? starred : view === 'HISTORY' ? history : matches;
  const filtered = useMemo(
    () => league === 'ALL' ? source : source.filter(m => m.league === league),
    [source, league]
  );

  const dueCount = starred.filter(m => /DUE|checkpoint|result/i.test(nextCheckpoint(m))).length;
  const triggerCount = starred.filter(m => m.state === 'TRIGGER').length;
  const qualifiedCount = matches.filter(m => m.state === 'QUALIFIED').length;

  return (
    <main className="shell">
      <header>
        <div>
          <p className="eyebrow">FOOTBALL TRADING</p>
          <h1>V1 Auto Scanner</h1>
        </div>
        <div className="headerActions">
          <button className="notify" onClick={enableNotifications}>Alerts</button>
          <button className="addBtn" onClick={scanUpcoming} disabled={loading}>
            {loading ? 'Scanning…' : 'Scan 72h'}
          </button>
        </div>
      </header>

      {notice && <div className="toast" onClick={() => setNotice('')}>{notice}</div>}

      <section className="summary">
        <div><span>V1 matches</span><strong>{qualifiedCount}</strong></div>
        <div><span>★ Saved</span><strong>{starred.length}</strong></div>
        <div><span>Checks due</span><strong>{dueCount}</strong></div>
      </section>

      <nav className="mainTabs">
        <button className={view === 'STARRED' ? 'active' : ''} onClick={() => setView('STARRED')}>★ Watchlist</button>
        <button className={view === 'SCANNER' ? 'active' : ''} onClick={() => setView('SCANNER')}>Next 72h</button>
        <button className={view === 'HISTORY' ? 'active' : ''} onClick={() => setView('HISTORY')}>History</button>
      </nav>

      <nav className="leagueTabs">
        {leagues.map(item => (
          <button key={item} className={league === item ? 'active' : ''} onClick={() => setLeague(item)}>
            {item === 'ALL' ? 'All' : item}
          </button>
        ))}
      </nav>

      {view === 'HISTORY' && history.length > 0 && (
        <div className="historyBar">
          <span>Every checkpoint snapshot is saved locally.</span>
          <button onClick={() => { setHistory([]); localStorage.removeItem(HISTORY_KEY); }}>Clear</button>
        </div>
      )}

      <section className="matchList">
        {filtered.length > 0 ? filtered.map(match => (
          <div key={`${match.id}-${view}-${match.checkedAt}`}>
            {view === 'STARRED' && <div className="checkpointLabel">{nextCheckpoint(match)}</div>}
            <MatchCard
              match={match}
              starred={starred.some(m => m.id === match.id)}
              onToggleStar={view !== 'HISTORY' ? toggleStar : undefined}
              onCheckpoint={view !== 'HISTORY' ? setCheckpoint : undefined}
              onHtCheck={view === 'STARRED' ? runHtCheck : undefined}
              htLoading={htLoadingId === match.id}
              compact={view === 'HISTORY'}
            />
          </div>
        )) : (
          <div className="emptyState">
            <strong>
              {view === 'STARRED'
                ? 'No V1 matches in ★ yet'
                : view === 'HISTORY'
                  ? 'No checkpoint history yet'
                  : loading ? 'Scanning upcoming matches…' : 'No qualifying matches found'}
            </strong>
            <span>
              {view === 'STARRED'
                ? 'Qualified matches from the next 72 hours will be added automatically.'
                : view === 'HISTORY'
                  ? 'Checkpoint snapshots will appear here.'
                  : 'The scanner only shows verified upcoming fixtures with usable pre-match lines.'}
            </span>
          </div>
        )}
      </section>

      {checkpoint && (
        <div className="modalBackdrop" onClick={() => setCheckpoint(null)}>
          <form className="checkpointForm" onSubmit={submitCheckpoint} onClick={e => e.stopPropagation()}>
            <div className="modalTop">
              <div>
                <p className="eyebrow">CHECKPOINT</p>
                <strong>{checkpoint.home} vs {checkpoint.away}</strong>
              </div>
              <button type="button" className="closeBtn" onClick={() => setCheckpoint(null)}>×</button>
            </div>

            <div className="formGrid">
              <select name="status" defaultValue={checkpoint.status === 'PRE' ? 'HT' : checkpoint.status}>
                <option value="LIVE">LIVE</option>
                <option value="HT">HT</option>
                <option value="FT">FT</option>
              </select>
              <input name="minute" type="number" placeholder="Minute" defaultValue={checkpoint.minute ?? 45} />
              <input name="scoreHome" type="number" min="0" placeholder="Home goals" defaultValue={checkpoint.scoreHome} />
              <input name="scoreAway" type="number" min="0" placeholder="Away goals" defaultValue={checkpoint.scoreAway} />
              <input name="cornersHome" type="number" min="0" placeholder="Home corners" defaultValue={checkpoint.cornersHome} />
              <input name="cornersAway" type="number" min="0" placeholder="Away corners" defaultValue={checkpoint.cornersAway} />
              <input name="liveCornerLine" type="number" step="0.25" placeholder="365 live corner line" defaultValue={checkpoint.liveCornerLine ?? ''} />
              <input name="liveGoalLine" type="number" step="0.25" placeholder="365 live goal line" defaultValue={checkpoint.liveGoalLine ?? ''} />
            </div>

            <div className="checkFlags">
              <label><input type="checkbox" name="favCovering" /> Favourite covering handicap</label>
              <label><input type="checkbox" name="favLosing" /> Favourite losing</label>
              <label><input type="checkbox" name="goalClear" /> FT Over Goals already clear</label>
            </div>

            <button className="primaryBtn" type="submit">Evaluate V1 snapshot</button>
            <p className="formHint">At the checkpoint, enter only the current Bet365 snapshot. The app recalculates V1 and saves it to History.</p>
          </form>
        </div>
      )}

      <footer>
        <span>Pre-match auto scan · live checks on demand</span>
        <span>{updatedAt ? `Last scan ${new Date(updatedAt).toLocaleTimeString()}` : 'Waiting for scan'}</span>
        {nextRefreshAt && <span>{`Free refresh after ${new Date(nextRefreshAt).toLocaleTimeString()}`}</span>}
        {scanStatus && <span>{`Scan ${scanStatus}${scanCoverage ? ` · ${scanCoverage}` : ''}`}</span>}
        {budgetStatus && <span>{budgetStatus}</span>}
      </footer>
    </main>
  );
}
