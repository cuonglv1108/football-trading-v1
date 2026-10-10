'use client';

import { useState } from 'react';
import { TradingMatch } from '../lib/types';
import { deriveH2Execution } from '../lib/h2Execution';

type Props = {
  match: TradingMatch;
  starred?: boolean;
  onToggleStar?: (match: TradingMatch) => void;
  onCheckpoint?: (match: TradingMatch) => void;
  onHtCheck?: (match: TradingMatch) => void;
  htLoading?: boolean;
  compact?: boolean;
};

export default function MatchCard({ match, starred = false, onToggleStar, onCheckpoint, onHtCheck, htLoading = false, compact = false }: Props) {
  const totalCorners = match.cornersHome + match.cornersAway;
  const probability = match.winProbability ?? 0;
  const [expanded, setExpanded] = useState(false);
  const favouriteName = match.favourite === 'AWAY' ? match.away : match.home;
  const handicapText = match.handicapVerified === false
    ? '—'
    : `${favouriteName} ${match.handicap > 0 ? '+' : ''}${match.handicap}`;
  const reliableFt = match.researchPhase === 'FT' && match.ftVerified === true &&
    /^API-Football fixture \d+/.test(match.ftSourceSummary ?? '');
  const verifiedHt = match.htVerified === true && match.htSourceType === 'API_FOOTBALL';
  const manualHt = match.htSourceType === 'MANUAL';
  const unverifiedHt = Boolean(match.htAction) && !verifiedHt && !manualHt;
  const execution = match.htAction && verifiedHt ? deriveH2Execution(match) : null;
  const executionText = unverifiedHt ? 'UNVERIFIED HT · NO AUTOMATIC ENTRY'
    : manualHt ? (match.htAction === 'NO_ENTRY' ? 'NO ENTRY · MANUAL HT' : 'MANUAL HT · VERIFY BEFORE ENTRY')
    : (execution?.text ?? match.h2ExecutionText);
  const executionDetail = unverifiedHt
    ? 'Previous GPT-search HT corners and H2 lines were not verified against a fixture/statistics provider. This signal is disabled.'
    : manualHt ? 'User-entered figures, not independently verified. Check halftime corners and H2 odds with the sportsbook.'
    : (execution?.detail ?? match.h2ExecutionDetail);

  return (
    <article className={`card state-${match.state?.toLowerCase()} ${compact ? 'compact' : ''}`}>
      <div className="cardTop">
        <span className="league">{match.league}</span>
        <div className="cardActions">
          {match.notable && <span className="notableBadge">★ V1 PICK</span>}
          {onToggleStar && (
            <button
              className={`starBtn ${starred ? 'active' : ''}`}
              onClick={() => onToggleStar(match)}
              aria-label={starred ? 'Remove from starred' : 'Add to starred'}
            >
              ★
            </button>
          )}
          <span className="status">{match.watchStatus === 'EXPIRED_UNVERIFIED' ? 'ARCHIVED' : match.status === 'LIVE' ? `${match.minute}'` : match.status}</span>
        </div>
      </div>

      <div className="teams">
        <strong>{match.home}</strong>
        <span>{unverifiedHt ? '— - —' : `${match.scoreHome} - ${match.scoreAway}`}</span>
        <strong>{match.away}</strong>
      </div>

      {match.kickoff && (
        <div className="kickoff">
          {new Date(match.kickoff).toLocaleString()}
          {match.checkedAt ? ` · checked ${new Date(match.checkedAt).toLocaleTimeString()}` : ''}
        </div>
      )}

      {match.watchStatus === 'EXPIRED_UNVERIFIED' && (
        <div className="htAdvice">
          <b>ARCHIVED · FT NOT VERIFIED</b>
          <p>Removed from active watchlist after the match window. This is not a confirmed final score.</p>
        </div>
      )}
      {match.researchPhase === 'FT' && !reliableFt && (
        <div className="htAdvice">
          <b>LEGACY FT DATA · UNVERIFIED</b>
          <p>Old web-search FT records are retained for audit, not graded as verified outcomes.</p>
        </div>
      )}
      {unverifiedHt && (
        <div className="htAdvice">
          <b>OLD HT SNAPSHOT IS UNVERIFIED</b>
          <p>Legacy corners and odds were not source-verified. The previous V1 H2 recommendation has been withdrawn.</p>
        </div>
      )}
      {executionText && (
        <div className="htAdvice">
          <div className="htAdviceTop">
            <span>H2 NEXT STEP</span>
            <b>{executionText}</b>
          </div>
          {executionDetail && <p>{executionDetail}</p>}
          {!unverifiedHt && (match.liveGoalLine != null || match.liveCornerLine != null) && (
            <small>H2 lines · Goals {match.liveGoalLine ?? '—'} · Corners {match.liveCornerLine ?? '—'}</small>
          )}
        </div>
      )}

      <button className="detailsBtn" onClick={() => setExpanded(v => !v)}>
        {expanded ? 'Hide analysis' : compact ? 'View analysis & result' : 'View details'}
      </button>

      {expanded && (
        <>
          <div className="metrics">
            <div><span>Corners</span><b>{unverifiedHt ? 'UNVERIFIED' : `${match.cornersHome}-${match.cornersAway} (${totalCorners})`}</b></div>
            <div><span>Pre corner</span><b>{match.prematchCornerLine}</b></div>
            <div><span>Pre goals</span><b>{match.prematchGoalLine}</b></div>
            <div><span>FT handicap</span><b>{handicapText}</b></div>
          </div>

          {match.sourceSummary && (
            <div className="sourceBox">
              <span>Pre-match odds source (not HT)</span>
              <b>{match.sourceSummary}</b>
              {(match.sourceUrls ?? []).slice(0, 2).map((url, i) => (
                <a key={url + i} href={url} target="_blank" rel="noreferrer">Open source {i + 1}</a>
              ))}
            </div>
          )}

          {!unverifiedHt && (match.liveCornerLine != null || match.liveGoalLine != null) && (
            <div className="liveLines">
              <span>365 snapshot</span>
              <b>C {match.liveCornerLine ?? '—'} · G {match.liveGoalLine ?? '—'}</b>
            </div>
          )}

          <div className="probabilityRow">
            <div>
              <span>V1</span>
              <b>{probability}%</b>
            </div>
            <div className="probabilityTrack">
              <div className="probabilityFill" style={{ width: `${probability}%` }} />
            </div>
          </div>

          {!unverifiedHt && (match.redCardsHome != null || match.redCardsAway != null) && (
            <div className="liveLines">
              <span>Red cards</span>
              <b>{match.redCardsHome ?? 0} - {match.redCardsAway ?? 0}</b>
            </div>
          )}

          {(match.h2ActualGoals != null || match.h2ActualCorners != null) && (
            <div className="liveLines">
              <span>H2 actual</span>
              <b>Goals {match.h2ActualGoals ?? '—'} · Corners {match.h2ActualCorners ?? '—'}</b>
              {reliableFt && (
                <small>
                  {match.h2ActualGoals != null
                    ? `H2 goals produced ${match.h2ActualGoals}. ${match.h2ActualGoals >= 2 ? 'This was strong H2 goal activity, but exact WIN/PUSH depends on the HT line.' : match.h2ActualGoals === 1 ? 'Some lower H2 goal lines may have won/pushed; exact grade depends on the HT line.' : 'No H2 goals were scored.'}`
                    : ''}
                  {match.h2ActualCorners != null
                    ? ` H2 corners produced ${match.h2ActualCorners}. Exact outcome depends on the H2 corner line saved at HT.`
                    : ''}
                </small>
              )}
            </div>
          )}

          {!unverifiedHt && (match.h2Predictions ?? []).length > 0 && (
            <div className="htAdvice">
              <div className="htAdviceTop">
                <span>H2 RESEARCH RECORD</span>
                <b>{reliableFt ? 'GRADED' : match.researchPhase === 'FT' ? 'UNVERIFIED FT' : 'PENDING FT'}</b>
              </div>
              {(match.h2Predictions ?? []).map((p, i) => (
                <div key={`${p.market}-${i}`} className="liveLines">
                  <span>{p.market.replace(/_/g, ' ')}</span>
                  <b>
                    {p.active ? `OVER ${p.line ?? '—'}` : `RESEARCH ONLY · line ${p.line ?? '—'}`}
                    {p.grade && p.grade !== 'PENDING' ? ` · ${p.grade.replace(/_/g, ' ')}` : ''}
                  </b>
                  <small>{p.note}</small>
                  {p.actual != null && <small>Actual H2: {p.actual}</small>}
                  {match.researchPhase === 'FT' && p.grade === 'UNRESOLVED' && (
                    <small>
                      Exact bet grade is unresolved because the HT market line was not verified.
                      {p.actual != null ? ` The actual H2 result was ${p.actual}, so this record still remains useful as research data.` : ''}
                    </small>
                  )}
                </div>
              ))}
            </div>
          )}

          {match.htAction && (
            <div className="htAdvice">
              {(verifiedHt || manualHt) && (
                <small>HT source: {match.htSourceSummary ?? (manualHt ? 'MANUAL INPUT' : 'API-Football')}</small>
              )}
              <div className="htAdviceTop">
                <span>HT DECISION</span>
                <b>{unverifiedHt ? 'UNVERIFIED · DISABLED' : match.htAction.replace(/_/g, ' ')}</b>
              </div>
              {unverifiedHt
                ? <p>Previous GPT-based HT decision is withdrawn. Verify the correct HT score and corners before using V1.</p>
                : match.htAdvice && <p>{match.htAdvice}</p>}
              {!unverifiedHt && match.htConfidence && <small>Confidence: {match.htConfidence}</small>}
              {!unverifiedHt && match.htEvaluationType && <small>Record type: {match.htEvaluationType.replace(/_/g, ' ')}</small>}
              {!unverifiedHt && match.h2GoalsAssessment && <small>H2 Goals: {match.h2GoalsAssessment.replace(/_/g, ' ')}</small>}
              {!unverifiedHt && match.h2CornersAssessment && <small>H2 Corners: {match.h2CornersAssessment.replace(/_/g, ' ')}</small>}
              {!unverifiedHt && match.htDataNote && <p className="htDataNote">{match.htDataNote}</p>}
              {(match.htMissingInputs ?? []).length > 0 && (
                <small>Missing: {(match.htMissingInputs ?? []).join(', ')}</small>
              )}
              {(match.htSourceUrls ?? []).slice(0,2).map((url, i) => (
                <a key={url+i} href={url} target="_blank" rel="noreferrer">HT source {i + 1}</a>
              ))}
              {(match.ftSourceUrls ?? []).slice(0,2).map((url, i) => (
                <a key={`ft-${url}-${i}`} href={url} target="_blank" rel="noreferrer">FT source {i + 1}</a>
              ))}
            </div>
          )}

          {onHtCheck && match.status !== 'FT' && (
            <button className="htCheckBtn" onClick={() => onHtCheck(match)} disabled={htLoading}>
              {htLoading ? 'Verifying HT…' : 'Verify HT'}
            </button>
          )}

          {onCheckpoint && match.status !== 'FT' && (
            <button className="checkBtn" onClick={() => onCheckpoint(match)}>Manual Check</button>
          )}
        </>
      )}
    </article>
  );
}
