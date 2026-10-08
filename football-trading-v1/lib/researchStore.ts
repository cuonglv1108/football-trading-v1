import { promises as fs } from 'fs';
import path from 'path';
import { TradingMatch } from './types';

const HISTORY_FILE = process.env.V1_RESEARCH_FILE || '/data/v1-research-history.json';

async function readAll(): Promise<TradingMatch[]> {
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf8');
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: TradingMatch[]) {
  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  const temp = `${HISTORY_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(rows), 'utf8');
  await fs.rename(temp, HISTORY_FILE);
}

export async function listResearch(limit = 500) {
  const rows = await readAll();
  return rows.slice(0, limit);
}

export async function saveResearch(snapshot: TradingMatch) {
  const rows = await readAll();
  const key = `${snapshot.id}|${snapshot.researchPhase ?? snapshot.status}|${snapshot.checkedAt ?? snapshot.htCheckedAt ?? snapshot.ftCheckedAt ?? ''}`;
  const deduped = rows.filter(row => {
    const rowKey = `${row.id}|${row.researchPhase ?? row.status}|${row.checkedAt ?? row.htCheckedAt ?? row.ftCheckedAt ?? ''}`;
    return rowKey !== key;
  });
  const next = [snapshot, ...deduped].slice(0, 1000);
  await writeAll(next);
  return snapshot;
}

export async function saveResearchBatch(snapshots: TradingMatch[]) {
  let rows = await readAll();
  for (const snapshot of snapshots) {
    const phase = snapshot.researchPhase ?? snapshot.status;
    rows = rows.filter(row => !(row.id === snapshot.id && (row.researchPhase ?? row.status) === phase));
    rows.unshift(snapshot);
  }
  rows = rows.slice(0, 1000);
  await writeAll(rows);
  return snapshots;
}
