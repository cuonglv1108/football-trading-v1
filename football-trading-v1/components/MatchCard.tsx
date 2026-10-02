'use client';

import { TradingMatch } from '../lib/types';

const stateLabel = {
  QUALIFIED: 'QUALIFIED',
  WATCHING: 'WAIT HT',
  TRIGGER: 'V1 TRIGGER',
  CANCELLED: 'CANCELLED',
};

export default function MatchCard({ match }: { match: TradingMatch }) {
  const totalCorners = match.cornersHome + match.cornersAway;
  return (
    <article className={`card state-${match.state?.toLowerCase()}`}>
      <div className="cardTop">
        <span className="league">{match.league}</span>
        <span className="status">{match.status === 'LIVE' ? `${match.minute}'` : match.status}</span>
      </div>

      <div className="teams">
        <strong>{match.home}</strong>
        <span>{match.scoreHome} - {match.scoreAway}</span>
        <strong>{match.away}</strong>
      </div>

      <div className="metrics">
        <div><span>Corners</span><b>{match.cornersHome}-{match.cornersAway} ({totalCorners})</b></div>
        <div><span>Pre corner</span><b>{match.prematchCornerLine}</b></div>
        <div><span>Pre goals</span><b>{match.prematchGoalLine}</b></div>
      </div>

      <div className="signal">
        <div className="dot" />
        <div>
          <b>{stateLabel[match.state ?? 'WATCHING']}</b>
          <p>{match.reasons?.[0]}</p>
        </div>
      </div>
    </article>
  );
}
