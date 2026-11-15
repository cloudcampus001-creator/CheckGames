import { pollRoom } from "@/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ code: string }> };

const headers = { "Cache-Control": "no-store" };

/**
 * How the browser follows a game: it asks about every second. `since` is the
 * tag of the view it already has; if nothing changed, the answer is short.
 * Asking also lets the room know this player is here and gives bots their
 * turns, so there is nothing running between requests.
 */
export async function GET(request: Request, { params }: Context) {
  const { code } = await params;
  const url = new URL(request.url);

  try {
    const result = await pollRoom(
      code,
      url.searchParams.get("seat") ?? "",
      url.searchParams.get("token") ?? "",
      url.searchParams.get("since") ?? "",
    );

    if (!result.ok) {
      // Only "gone" and "not yours" are final; a busy server is just retried.
      return Response.json(
        { error: result.error, fatal: result.fatal === true, ok: false },
        { headers, status: result.status },
      );
    }

    return Response.json({ etag: result.etag, ok: true, view: result.view }, { headers });
  } catch (error) {
    console.error("poll failed", error);

    return Response.json(
      { error: "The game server is busy.", fatal: false, ok: false },
      { headers, status: 503 },
    );
  }
}
