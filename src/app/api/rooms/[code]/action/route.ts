import { act } from "@/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ code: string }> };

/** Everything a player does: play, draw, and the host's controls. */
export async function POST(request: Request, { params }: Context) {
  const { code } = await params;
  let body: { action?: unknown; seatId?: unknown; token?: unknown };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { error: "That request was not understood.", ok: false },
      { status: 400 },
    );
  }

  try {
    const result = await act(code, body.seatId, body.token, body.action);

    return Response.json(result, { status: result.ok ? 200 : result.status });
  } catch (error) {
    console.error("action failed", error);

    return Response.json(
      { error: "The game server is busy. Please try again.", ok: false },
      { status: 503 },
    );
  }
}
