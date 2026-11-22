import { leaderboard } from "@/server/profiles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

/** The players with the most XP. */
export async function GET() {
  try {
    return Response.json({ ok: true, players: await leaderboard(20) }, { headers });
  } catch (error) {
    console.error("leaderboard failed", error);

    return Response.json({ error: "The game server is busy.", ok: false }, { headers, status: 503 });
  }
}
