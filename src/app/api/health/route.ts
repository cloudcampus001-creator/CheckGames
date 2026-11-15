import { pingStore } from "@/server/service";
import { storageInfo } from "@/server/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

/**
 * Open /api/health in a browser to see how the game keeps its rooms. On
 * Vercel it must say storage "redis"; "memory" there means games will vanish.
 */
export async function GET() {
  const info = storageInfo();
  const warning =
    info.persistent
      ? null
      : "Games are kept in memory, which Vercel does not keep between requests. Add an Upstash Redis database to the project (see README) or games will disappear.";

  try {
    const latencyMs = await pingStore();

    return Response.json(
      { latencyMs, ok: true, storage: info.kind, warning },
      { headers },
    );
  } catch (error) {
    console.error("health check failed", error);

    return Response.json(
      {
        error: "The game storage did not answer.",
        ok: false,
        storage: info.kind,
        warning,
      },
      { headers, status: 503 },
    );
  }
}
