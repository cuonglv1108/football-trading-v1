'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import MatchCard from '../components/MatchCard';
import { evaluateV1 } from '../lib/rules';
import { League, TradingMatch } from '../lib/types';

const leagues: Array<'ALL' | League> = ['ALL', 'MLS', 'Allsvenskan', 'Liga MX'];
type View = 'SCANNER' | 'STARRED' | 'HISTORY';

const WATCH_KEY = 'football-trading-v1-watch';
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
  if (!match.kickoff) return 'Manual check';
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
  const [view, setView] = useState<View>('STARRED');
  const [showAdd, setShowAdd] = useState(false);
  const [checkpoint, setCheckpoint] = useState<TradingMatch | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setMatches(readSaved(WATCH_KEY));
    setStarred(readSaved(STAR_KEY));
    setHistory(readSaved(HISTORY_KEY));
  }, []);

  function saveWatch(next: TradingMatch[]) {
    setMatches(next);
    localStorage.setItem(WATCH_KEY, JSON.stringify(next));
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

  function toggleStar(match: TradingMatch) {
    const exists = starred.some(m => m.id === match.id);
    saveStarred(exists ? starred.filter(m => m.id !== match.id) : [{ ...match }, ...starred]);
  }

  function addMatch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const kickoffLocal = String(fd.get('kickoff') || '');

    const base: TradingMatch = {
      id: `manual-${Date.now()}`,
      league: String(fd.get('league')) as League,
      home: String(fd.get('home') || '').trim(),
      away: String(fd.get('away') || '').trim(),
      minute: null,
      status: 'PRE',
      kickoff: kickoffLocal ? new Date(kickoffLocal).toISOString() : null,
      scoreHome: 0,
      scoreAway: 0,
      cornersHome: 0,
      cornersAway: 0,
      prematchCornerLine: Number(fd.get('cornerLine')),
      prematchGoalLine: Number(fd.get('goalLine')),
      favourite: String(fd.get('favourite')) as 'HOME' | 'AWAY',
      handicap: Number(fd.get('handicap')),
      favouriteCoveringHandicap: false,
      favouriteLosing: false,
      ftGoalOverClear: false,
      checkedAt: new Date().toISOString(),
    };

    if (!base.home || !base.away || Number.isNaN(base.prematchCornerLine) || Number.isNaN(base.prematchGoalLine)) {
      setNotice('Please complete the match and pre-match lines.');
      return;
    }

    const evaluated = { ...base, ...evaluateV1(base) };
    saveWatch([evaluated, ...matches]);

    if (evaluated.state === 'QUALIFIED') {
      saveStarred([evaluated, ...starred.filter(m => m.id !== evaluated.id)]);
      setNotice('★ Added to watchlist — V1 pre-match filter passed.');
    } else {
      setNotice('Saved to Scanner, but it did not pass V1 pre-match filter.');
    }

    e.currentTarget.reset();
    setShowAdd(false);
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
    saveWatch(matches.map(m => m.id === evaluated.id ? evaluated : m));
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
    if ('Notification' in window) await Notification.requestPermission();
  }

  const source = view === 'STARRED' ? starred : view === 'HISTORY' ? history : matches;
  const filtered = useMemo(
    () => league === 'ALL' ? source : source.filter(m => m.league === league),
    [source, league]
  );

  const dueCount = starred.filter(m => /DUE|checkpoint|result/i.test(nextCheckpoint(m))).length;
  const triggerCount = starred.filter(m => m.state === 'TRIGGER').length;

  return (
    <main className="shell">
      <header>
        <div>
          <p className="eyebrow">FOOTBALL TRADING</p>
          <h1>V1 Checkpoints</h1>
        </div>
        <div className="headerActions">
          <button className="notify" onClick={enableNotifications}>Alerts</button>
          <button className="addBtn" onClick={() => setShowAdd(v => !v)}>+ Match</button>
        </div>
      </header>

      <section className="feedNotice onDemand" role="status">
        <strong>ON-DEMAND MODE</strong>
        <span>No continuous API polling. Save pre-match V1 candidates, then check only at your trading checkpoints.</span>
      </section>

      {notice && <div className="toast" onClick={() => setNotice('')}>{notice}</div>}

      {showAdd && (
        <form className="quickForm" onSubmit={addMatch}>
          <div className="formTitle">Pre-match shortlist</div>
          <div className="formGrid">
            <select name="league" defaultValue="MLS">
              <option>MLS</option>
              <option>Allsvenskan</option>
              <option>Liga MX</option>
            </select>
            <input name="kickoff" type="datetime-local" />
            <input name="home" placeholder="Home team" required />
            <input name="away" placeholder="Away team" required />
            <input name="cornerLine" type="number" step="0.25" placeholder="Corner line e.g. 10.5" required />
            <input name="goalLine" type="number" step="0.25" placeholder="Goal line e.g. 3.0" required />
            <select name="favourite" defaultValue="HOME">
              <option value="HOME">Home favourite</option>
              <option value="AWAY">Away favourite</option>
            </select>
            <input name="handicap" type="number" step="0.25" defaultValue="-0.75" />
          </div>
          <button className="primaryBtn" type="submit">Run V1 + Save</button>
        </form>
      )}

      <section className="summary">
        <div><span>★ Saved</span><strong>{starred.length}</strong></div>
        <div><span>Checks due</span><strong>{dueCount}</strong></div>
        <div><span>Triggers</span><strong>{triggerCount}</strong></div>
      </section>

      <nav className="mainTabs">
        <button className={view === 'STARRED' ? 'active' : ''} onClick={() => setView('STARRED')}>★ Watchlist</button>
        <button className={view === 'SCANNER' ? 'active' : ''} onClick={() => setView('SCANNER')}>Scanner</button>
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
              compact={view === 'HISTORY'}
            />
          </div>
        )) : (
          <div className="emptyState">
            <strong>{view === 'STARRED' ? 'No matches in ★ yet' : view === 'HISTORY' ? 'No checkpoint history yet' : 'No scanned matches yet'}</strong>
            <span>{view === 'STARRED' ? 'Add a pre-match candidate. V1-qualified matches are starred automatically.' : 'Nothing to show yet.'}</span>
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
            <p className="formHint">Enter the current Bet365 snapshot once. The app recalculates V1 and saves it to History.</p>
          </form>
        </div>
      )}

      <footer>
        <span>Checkpoint workflow · no continuous feed cost</span>
        <span>Saved on this device</span>
      </footer>
    </main>
  );
}
