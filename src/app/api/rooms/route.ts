import { createRoom } from "@/server/service";

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

  try {
    const result = await createRoom(name);

    return Response.json(result, { status: result.ok ? 200 : result.status });
  } catch (error) {
    console.error("create room failed", error);

    return Response.json(
      { error: "The game server is busy. Please try again.", ok: false },
      { status: 503 },
    );
  }
}
