'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import MatchCard from '../components/MatchCard';
import { League, TradingMatch } from '../lib/types';

const leagues: Array<'ALL' | League> = ['ALL', 'MLS', 'Allsvenskan', 'Liga MX'];
type FeedMode = 'DEMO' | 'NO_LIVE_PROVIDER' | 'LIVE';
type View = 'SCANNER' | 'STARRED' | 'HISTORY';

const STAR_KEY = 'football-trading-v1-starred';
const HISTORY_KEY = 'football-trading-v1-history';

export default function Home() {
  const [matches, setMatches] = useState<TradingMatch[]>([]);
  const [league, setLeague] = useState<'ALL' | League>('ALL');
  const [view, setView] = useState<View>('SCANNER');
  const [starred, setStarred] = useState<TradingMatch[]>([]);
  const [history, setHistory] = useState<TradingMatch[]>([]);
  const [updatedAt, setUpdatedAt] = useState('');
  const [mode, setMode] = useState<FeedMode>('NO_LIVE_PROVIDER');
  const [dataSource, setDataSource] = useState<string | null>(null);
  const previousStates = useRef<Record<string, string>>({});

  useEffect(() => {
    try {
      setStarred(JSON.parse(localStorage.getItem(STAR_KEY) || '[]'));
      setHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'));
    } catch {}
  }, []);

  function persistStarred(next: TradingMatch[]) {
    setStarred(next);
    localStorage.setItem(STAR_KEY, JSON.stringify(next));
  }

  function persistHistory(next: TradingMatch[]) {
    const deduped = Array.from(new Map(next.map(m => [`${m.id}-${m.state}-${m.status}`, m])).values()).slice(0, 100);
    setHistory(deduped);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(deduped));
  }

  function toggleStar(match: TradingMatch) {
    const exists = starred.some(m => m.id === match.id);
    persistStarred(exists ? starred.filter(m => m.id !== match.id) : [{ ...match }, ...starred]);
  }

  async function refresh() {
    const res = await fetch('/api/matches', { cache: 'no-store' });
    const data = await res.json();
    const incoming = (data.matches ?? []) as TradingMatch[];

    setMatches(incoming);
    setUpdatedAt(data.updatedAt ?? '');
    setMode(data.mode ?? 'NO_LIVE_PROVIDER');
    setDataSource(data.dataSource ?? null);

    if (data.mode !== 'LIVE') return;

    for (const m of incoming) {
      const prev = previousStates.current[m.id];

      if (m.notable && !starred.some(s => s.id === m.id)) {
        persistStarred([{ ...m }, ...starred]);
      }

      if (prev && prev !== 'TRIGGER' && m.state === 'TRIGGER') {
        persistHistory([{ ...m }, ...history]);

        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(`V1 TRIGGER — ${m.home} vs ${m.away}`, {
            body: `${m.status} | ${m.scoreHome}-${m.scoreAway} | Corners ${m.cornersHome}-${m.cornersAway} | V1 ${m.winProbability ?? 0}%`,
          });
        }
      }

      if (m.status === 'FT' && prev !== 'FT') {
        persistHistory([{ ...m }, ...history]);
      }

      previousStates.current[m.id] = m.state ?? '';
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 1000);
    return () => clearInterval(id);
  }, [starred, history]);

  const sourceList = view === 'STARRED' ? starred : view === 'HISTORY' ? history : matches;
  const filtered = useMemo(
    () => league === 'ALL' ? sourceList : sourceList.filter(m => m.league === league),
    [sourceList, league]
  );

  const liveCount = matches.filter(m => m.status === 'LIVE' || m.status === 'HT').length;
  const triggerCount = matches.filter(m => m.state === 'TRIGGER').length;
  const notableCount = matches.filter(m => m.notable).length;

  async function enableNotifications() {
    if ('Notification' in window) await Notification.requestPermission();
  }

  return (
    <main className="shell">
      <header>
        <div>
          <p className="eyebrow">FOOTBALL TRADING</p>
          <h1>V1 Scanner</h1>
        </div>
        <button className="notify" onClick={enableNotifications}>Enable alerts</button>
      </header>

      {mode !== 'LIVE' && (
        <section className="feedNotice" role="status">
          <strong>{mode === 'DEMO' ? 'DEMO MODE' : 'LIVE DATA NOT CONNECTED'}</strong>
          <span>
            {mode === 'DEMO'
              ? `Synthetic test data only${dataSource ? ` — ${dataSource}` : ''}. Not real fixtures.`
              : 'No matches are shown until a verified live provider is connected.'}
          </span>
        </section>
      )}

      <section className="summary">
        <div><span>Live</span><strong>{liveCount}</strong></div>
        <div><span>V1 picks</span><strong>{notableCount}</strong></div>
        <div><span>Triggers</span><strong>{triggerCount}</strong></div>
      </section>

      <nav className="mainTabs">
        <button className={view === 'SCANNER' ? 'active' : ''} onClick={() => setView('SCANNER')}>Scanner</button>
        <button className={view === 'STARRED' ? 'active' : ''} onClick={() => setView('STARRED')}>★</button>
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
          <span>Saved automatically when V1 triggers or a match finishes.</span>
          <button onClick={() => { setHistory([]); localStorage.removeItem(HISTORY_KEY); }}>Clear</button>
        </div>
      )}

      <section className="matchList">
        {filtered.length > 0
          ? filtered.map(match => (
              <MatchCard
                key={`${match.id}-${view}`}
                match={match}
                starred={starred.some(m => m.id === match.id)}
                onToggleStar={view !== 'HISTORY' ? toggleStar : undefined}
                compact={view === 'HISTORY'}
              />
            ))
          : <div className="emptyState">
              <strong>
                {view === 'STARRED' ? 'No starred matches yet' : view === 'HISTORY' ? 'No saved history yet' : 'No verified matches'}
              </strong>
              <span>
                {view === 'STARRED'
                  ? 'Upcoming V1 picks will be added here automatically. You can also star a match manually.'
                  : view === 'HISTORY'
                    ? 'Triggered and finished matches will be saved here automatically.'
                    : 'The scanner stays empty rather than showing guessed or synthetic fixtures.'}
              </span>
            </div>}
      </section>

      <footer>
        <span>{mode === 'LIVE' ? 'Verified live feed' : mode === 'DEMO' ? 'Demo feed' : 'Waiting for live provider'}</span>
        <span>{updatedAt ? `Checked ${new Date(updatedAt).toLocaleTimeString()}` : 'Connecting…'}</span>
      </footer>
    </main>
  );
}
