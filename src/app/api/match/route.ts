import { joinQueue, leaveQueue, pollQueue } from "@/server/matchService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

/** Matchmaking: join the queue ("join"), ask how it is going ("poll"), or give up ("leave"). */
export async function POST(request: Request) {
  let body: Record<string, unknown> = {};

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "That request was not understood.", ok: false }, { headers, status: 400 });
  }

  try {
    if (body.action === "join") {
      const result = await joinQueue(
        { id: body.id, secret: body.secret },
        { fillBots: body.fillBots, sizes: body.sizes, turn: body.turn },
      );

      return Response.json(result, { headers, status: result.ok ? 200 : 400 });
    }

    if (body.action === "leave") {
      return Response.json(await leaveQueue(body.ticket), { headers });
    }

    const result = await pollQueue(body.ticket);

    return Response.json(result, { headers, status: result.ok ? 200 : 503 });
  } catch (error) {
    console.error("match failed", error);

    return Response.json({ error: "The game server is busy. Please try again.", ok: false }, { headers, status: 503 });
  }
}
