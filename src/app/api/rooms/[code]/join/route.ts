import { joinRoom } from "@/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ code: string }> };

/** Take a seat in a game, or get your old seat back with your saved token. */
export async function POST(request: Request, { params }: Context) {
  const { code } = await params;
  let body: { name?: unknown; token?: unknown } = {};

  try {
    body = (await request.json()) as typeof body;
  } catch {
    // no body: defaults apply
  }

  try {
    const result = await joinRoom(code, body.name, body.token);

    return Response.json(result, { status: result.ok ? 200 : result.status });
  } catch (error) {
    console.error("join room failed", error);

    return Response.json(
      { error: "The game server is busy. Please try again.", ok: false },
      { status: 503 },
    );
  }
}
