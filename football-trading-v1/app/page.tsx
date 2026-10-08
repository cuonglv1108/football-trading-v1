'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import MatchCard from '../components/MatchCard';
import { evaluateV1 } from '../lib/rules';
import { League, SetupStats, TradingMatch } from '../lib/types';
import { buildH2Predictions } from '../lib/outcomes';

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
  const [batchLoading, setBatchLoading] = useState<'HT' | 'FT' | null>(null);
  const [setupStats, setSetupStats] = useState<SetupStats[]>([]);

  useEffect(() => {
    setStarred(readSaved(STAR_KEY));
    setHistory(readSaved(HISTORY_KEY));
    loadCachedScan();
    loadSharedResearch();
  }, []);

  async function loadSharedResearch() {
    try {
      const res = await fetch('/api/research', { cache: 'no-store' });
      const data = await res.json();
      const shared = (data.rows ?? []) as TradingMatch[];
      setSetupStats((data.stats ?? []) as SetupStats[]);
      if (!shared.length) return;
      setHistory(prev => {
        const merged = new Map<string, TradingMatch>();
        for (const m of shared) merged.set(`${m.id}-${m.researchPhase ?? m.status}`, m);
        for (const m of prev) {
          const key = `${m.id}-${m.researchPhase ?? m.status}`;
          if (!merged.has(key)) merged.set(key, m);
        }
        const next = Array.from(merged.values()).slice(0, 500);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        return next;
      });
    } catch {
      // Local history remains available if shared history cannot load.
    }
  }

  async function persistResearch(snapshot: TradingMatch) {
    try {
      await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
    } catch {
      // History still remains locally available.
    }
  }

  function dueForPhase(match: TradingMatch, phase: 'HT' | 'FT') {
    if (!match.kickoff) return false;
    const elapsed = (Date.now() - new Date(match.kickoff).getTime()) / 60000;
    if (phase === 'HT') return elapsed >= 43 && elapsed <= 85 && !match.htCheckedAt;
    return elapsed >= 105 && match.status !== 'FT';
  }

  async function runLiveBatch(phase: 'HT' | 'FT') {
    const candidates = starred.filter(m => dueForPhase(m, phase)).slice(0, 10);
    if (!candidates.length) {
      setNotice(phase === 'HT' ? 'No HT checks are due right now.' : 'No FT checks are due right now.');
      return;
    }

    setBatchLoading(phase);
    setNotice(`${phase} Batch · checking ${candidates.length} matches in one shared request…`);
    try {
      const res = await fetch('/api/live-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase, matches: candidates }),
      });
      const data = await res.json();

      if (data.providerStatus === 'DAILY_LIVE_BUDGET_REACHED') {
        setNotice('Live-data daily budget reached. No paid batch was started.');
        return;
      }
      if (data.providerStatus !== 'CONNECTED') {
        setNotice(data.error || 'Batch check failed.');
        return;
      }

      const results = (data.results ?? []) as TradingMatch[];
      const byId = new Map(results.map(m => [m.id, m]));
      setStarred(prev => {
        const next = prev.map(m => byId.get(m.id) ?? m);
        localStorage.setItem(STAR_KEY, JSON.stringify(next));
        return next;
      });
      setMatches(prev => prev.map(m => byId.get(m.id) ?? m));
      setHistory(prev => {
        const merged = [...results, ...prev];
        const deduped = Array.from(new Map(merged.map(m => [`${m.id}-${m.researchPhase ?? m.status}`, m])).values()).slice(0, 500);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(deduped));
        return deduped;
      });

      if (phase === 'FT') void loadSharedResearch();

      setNotice(
        `${phase} Batch · ${results.length} matches · ${data.webCalls ?? 0} web calls · est. ${Number(data.estimatedCostUsd ?? 0).toFixed(3)}`
      );
    } catch {
      setNotice(`${phase} Batch failed. Saved data was not overwritten.`);
    } finally {
      setBatchLoading(null);
    }
  }

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

      const baseUpdated: TradingMatch = {
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
        htScoreHome: data.scoreHome ?? null,
        htScoreAway: data.scoreAway ?? null,
        htCornersHome: data.cornersHome ?? null,
        htCornersAway: data.cornersAway ?? null,
        htEvaluationType: data.evaluationType,
        h2GoalsAssessment: data.h2GoalsAssessment,
        h2CornersAssessment: data.h2CornersAssessment,
        htDataNote: data.dataNote,
        checkedAt: data.checkedAt ?? new Date().toISOString(),
      };

      const updated: TradingMatch = {
        ...baseUpdated,
        h2Predictions: buildH2Predictions(baseUpdated),
      };

      setMatches(prev => prev.map(m => m.id === updated.id ? updated : m));
      setStarred(prev => {
        const next = prev.map(m => m.id === updated.id ? updated : m);
        localStorage.setItem(STAR_KEY, JSON.stringify(next));
        return next;
      });
      saveHistory([updated, ...history]);
      void persistResearch({ ...updated, researchPhase: 'HT' });
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
    void persistResearch({ ...evaluated, researchPhase: 'MANUAL' });

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
          <button className="notify" onClick={() => runLiveBatch('HT')} disabled={batchLoading !== null}>
            {batchLoading === 'HT' ? 'HT Batch…' : 'HT Batch'}
          </button>
          <button className="notify" onClick={() => runLiveBatch('FT')} disabled={batchLoading !== null}>
            {batchLoading === 'FT' ? 'FT Batch…' : 'FT Batch'}
          </button>
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

      {view === 'HISTORY' && (
        <>
          {setupStats.length > 0 && (
            <section className="historyStats">
              <div className="historyBar">
                <span>Historical V1 accuracy by setup. Small samples are intentionally marked as low confidence.</span>
              </div>
              <div className="matchList">
                {setupStats.map(stat => (
                  <div className="card compact" key={`${stat.market}-${stat.key}`}>
                    <div className="cardTop">
                      <span className="league">{stat.market.replace(/_/g, ' ')}</span>
                      <span className="status">{stat.confidenceLabel.replace(/_/g, ' ')}</span>
                    </div>
                    <strong>{stat.key.replace(/_/g, ' ')}</strong>
                    <div className="metrics">
                      <div><span>Samples</span><b>{stat.samples}</b></div>
                      <div><span>Observed</span><b>{stat.observedAccuracy}%</b></div>
                      <div><span>Smoothed</span><b>{stat.smoothedAccuracy}%</b></div>
                    </div>
                    <small>W {stat.fullWins} · 1/2W {stat.halfWins} · P {stat.pushes} · 1/2L {stat.halfLosses} · L {stat.fullLosses}</small>
                  </div>
                ))}
              </div>
            </section>
          )}
          {history.length > 0 && (
            <div className="historyBar">
              <span>HT recommendations and FT outcomes are shared and persisted for later V1 analysis.</span>
              <button onClick={() => { setHistory([]); localStorage.removeItem(HISTORY_KEY); }}>Clear local</button>
            </div>
          )}
        </>
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
