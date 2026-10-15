'use client';

import { useState } from 'react';
import { TradingMatch } from '../lib/types';
import { deriveH2Execution } from '../lib/h2Execution';
import { evaluateMethodOutcomes, inferVerifiedHtAction, methodMatchStatus } from '../lib/outcomes';

type Props = {
  match: TradingMatch;
  starred?: boolean;
  onToggleStar?: (match: TradingMatch) => void;
  onCheckpoint?: (match: TradingMatch) => void;
  onHtCheck?: (match: TradingMatch) => void;
  htLoading?: boolean;
  htCheckReady?: boolean;
  compact?: boolean;
  onDeleteHistory?: (match: TradingMatch) => void;
};

export default function MatchCard({ match, starred = false, onToggleStar, onCheckpoint, onHtCheck, htLoading = false, htCheckReady = false, compact = false, onDeleteHistory }: Props) {
  const totalCorners = match.cornersHome + match.cornersAway;
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
  const kickoffDate = match.kickoff ? new Date(match.kickoff) : null;
  const kickoffTime = kickoffDate && Number.isFinite(kickoffDate.getTime())
    ? kickoffDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'TBD';
  const statusLabel = match.watchStatus === 'EXPIRED_UNVERIFIED'
    ? 'ARCH'
    : match.status === 'PRE'
      ? kickoffTime
      : match.status === 'LIVE'
        ? `${match.minute ?? ''}'`
        : match.status;
  const showScore = match.status !== 'PRE' && !unverifiedHt;

  if (compact && match.researchPhase !== 'FT') return null;

  if (compact && match.researchPhase === 'FT') {
    const htCorners = match.htCornersHome != null && match.htCornersAway != null
      ? match.htCornersHome + match.htCornersAway
      : null;
    const methodOutcomes = evaluateMethodOutcomes(match);
    const inferredAction = inferVerifiedHtAction(match);
    const finalStatus = methodMatchStatus(match);
    const verifiedAction = inferredAction === 'H2_GOALS_AND_CORNERS'
      ? 'GOALS + CORNERS'
      : inferredAction === 'H2_CORNERS'
        ? 'CORNERS'
        : inferredAction === 'NO_ENTRY'
          ? 'NO ENTRY'
          : '—';

    return (
      <article className="card compact historyFinalCard">
        <div className="matchAccent" />
        <div className="matchCompactRow">
          <div className="matchTimeBlock">
            <strong>FT</strong>
            <span>{match.league}</span>
          </div>
          <div className="clubPair">
            <div className="clubLine">
              <span className="teamBadge">{match.homeLogo ? <img src={match.homeLogo} alt="" /> : <b>{match.home.slice(0, 2).toUpperCase()}</b>}</span>
              <strong>{match.home}</strong>
              <b className="teamScore">{match.ftScoreHome ?? match.scoreHome}</b>
            </div>
            <div className="clubLine">
              <span className="teamBadge">{match.awayLogo ? <img src={match.awayLogo} alt="" /> : <b>{match.away.slice(0, 2).toUpperCase()}</b>}</span>
              <strong>{match.away}</strong>
              <b className="teamScore">{match.ftScoreAway ?? match.scoreAway}</b>
            </div>
          </div>
          <div className="matchSideActions">
            <span className={`resultBadge ${finalStatus === 'WIN' ? 'win' : finalStatus === 'LOSE' ? 'lose' : finalStatus === 'NE' ? 'ne' : 'pending'}`}>
              {finalStatus ?? '—'}
            </span>
          </div>
        </div>

        <div className="historyCardActions">
          <button className="detailsBtn" onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Hide details' : 'Details'}
          </button>
          {onDeleteHistory && (
            <button
              className="historyDeleteBtn"
              onClick={() => onDeleteHistory(match)}
              aria-label={`Delete ${match.home} vs ${match.away} from history`}
            >
              Delete
            </button>
          )}
        </div>

        {expanded && (
          <div className="historyFinalDetails">
            <div className="verifyStrip">
              <span>HT VERIFIED</span>
              <b>{verifiedAction}</b>
              <small>Corners {htCorners ?? '—'} · G {match.liveGoalLine ?? '—'} · C {match.liveCornerLine ?? '—'}</small>
            </div>

            <div className="metrics">
              <div><span>Pre corner</span><b>{match.prematchCornerLine}</b></div>
              <div><span>Pre goals</span><b>{match.prematchGoalLine}</b></div>
              <div><span>H2 corners</span><b>{match.h2ActualCorners ?? '—'}</b></div>
              <div><span>H2 goals</span><b>{match.h2ActualGoals ?? '—'}</b></div>
            </div>

            {methodOutcomes.length > 0 && (
              <div className="methodResultCompact">
                {methodOutcomes.map((o, i) => (
                  <div key={`${o.market}-${i}`} className={`methodOutcome ${o.status.toLowerCase()}`}>
                    <span>{o.market === 'H2_CORNERS' ? 'CORNERS' : 'GOALS'}</span>
                    <b>{o.status}</b>
                    <small>
                      {o.market === 'H2_CORNERS' ? 'FT total ' : 'H2 '}
                      {o.actual ?? '—'} vs pre {o.benchmarkLine}
                    </small>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </article>
    );
  }

  return (
    <article className={`card state-${match.state?.toLowerCase()} ${compact ? 'compact' : ''}`}>
      <div className="matchAccent" />
      <div className="matchCompactRow">
        <div className="matchTimeBlock">
          <strong>{statusLabel}</strong>
          <span>{match.league}</span>
        </div>

        <div className="clubPair">
          <div className="clubLine">
            <span className="teamBadge">
              {match.homeLogo ? <img src={match.homeLogo} alt="" /> : <b>{match.home.slice(0, 2).toUpperCase()}</b>}
            </span>
            <strong>{match.home}</strong>
            <b className="teamScore">{showScore ? match.scoreHome : ''}</b>
          </div>
          <div className="clubLine">
            <span className="teamBadge">
              {match.awayLogo ? <img src={match.awayLogo} alt="" /> : <b>{match.away.slice(0, 2).toUpperCase()}</b>}
            </span>
            <strong>{match.away}</strong>
            <b className="teamScore">{showScore ? match.scoreAway : ''}</b>
          </div>
        </div>

        <div className="matchSideActions">
          {onToggleStar && (
            <button
              className={`starBtn ${starred ? 'active' : ''}`}
              onClick={() => onToggleStar(match)}
              aria-label={starred ? 'Remove from starred' : 'Add to starred'}
            >
              ★
            </button>
          )}
          {match.notable && <span className="v1Dot">V1</span>}
        </div>
      </div>

      {match.kickoff && (
        <div className="kickoff compactKickoff">
          {kickoffDate?.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
          {match.checkedAt ? ` · checked ${new Date(match.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
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
          {!unverifiedHt && (match.liveGoalLine != null || match.liveCornerLine != null) && (
            <small>H2 lines · Goals {match.liveGoalLine ?? '—'} · Corners {match.liveCornerLine ?? '—'}</small>
          )}
        </div>
      )}

      {onHtCheck && match.status !== 'FT' && (
        <div className="cardQuickActions">
          <button
            className={`htQuickBtn ${htCheckReady ? 'ready' : ''}`}
            onClick={() => onHtCheck(match)}
            disabled={
              htLoading ||
              (!htCheckReady && !(match.htVerified === true && (match.liveGoalLine == null || match.liveCornerLine == null))) ||
              (match.htVerified === true && match.liveGoalLine != null && match.liveCornerLine != null)
            }
          >
            {htLoading
              ? 'CHECKING HT + H2…'
              : match.htVerified === true && match.liveGoalLine != null && match.liveCornerLine != null
                ? 'HT + H2 VERIFIED ✓'
                : match.htVerified === true
                  ? 'REFRESH H2 LINES'
                  : htCheckReady
                    ? 'HT CHECK · GET H2 LINES'
                    : 'HT CHECK · AT HALFTIME'}
          </button>
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
            </div>
          )}

          {!unverifiedHt && evaluateMethodOutcomes(match).length > 0 && (
            <div className="htAdvice">
              <div className="htAdviceTop">
                <span>METHOD RESULT</span>
                <b>{evaluateMethodOutcomes(match).some(o => o.status === 'SUCCESS') ? 'CHECKED' : 'PENDING / CHECKED'}</b>
              </div>
              {evaluateMethodOutcomes(match).map((o, i) => (
                <div key={`method-${o.market}-${i}`} className="liveLines">
                  <span>{o.market.replace(/_/g, ' ')}</span>
                  <b>{o.status}</b>
                  <small>
                    {o.market === 'H2_CORNERS' ? 'FT corner total' : 'H2 actual'} {o.actual ?? '—'} · pre-match {o.benchmarkLine}
                  </small>
                </div>
              ))}
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
                  {p.actual != null && <small>Actual H2: {p.actual}</small>}
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

          {onCheckpoint && match.status !== 'FT' && (
            <button className="checkBtn" onClick={() => onCheckpoint(match)}>Manual Check</button>
          )}
        </>
      )}
    </article>
  );
}
