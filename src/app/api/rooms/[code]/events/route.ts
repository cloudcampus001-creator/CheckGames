export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The live stream was removed: it cannot work on serverless hosting such as
 * Vercel. Browsers now ask /state instead. This file only exists so an old page
 * still open somewhere gets a clear answer. You may delete the whole `events`
 * folder.
 */
export function GET() {
  return Response.json(
    { error: "This address is no longer used. Reload the page.", fatal: false, ok: false },
    { headers: { "Cache-Control": "no-store" }, status: 410 },
  );
}
