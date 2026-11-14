import { createRoom } from "@/server/rooms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Start a new game. The caller becomes the host. */
export async function POST(request: Request) {
  let name: unknown;

  try {
    name = ((await request.json()) as { name?: unknown }).name;
  } catch {
    // no body: fall back to the default host name
  }

  const { code, seatId, token } = createRoom(name);

  return Response.json({ code, ok: true, seatId, token });
}
