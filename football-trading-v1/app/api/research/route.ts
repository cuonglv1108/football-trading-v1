import { NextRequest, NextResponse } from 'next/server';
import { listResearch, saveResearch } from '../../../lib/researchStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const rows = await listResearch(500);
  return NextResponse.json({ rows }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

export async function POST(req: NextRequest) {
  try {
    const snapshot = await req.json();
    await saveResearch(snapshot);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Could not save research snapshot',
    }, { status: 200 });
  }
}
