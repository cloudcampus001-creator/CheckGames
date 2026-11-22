import { hello, updateProfile } from "@/server/profiles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

/** A device opens its profile ("hello"), or changes its name, face or look ("update"). */
export async function POST(request: Request) {
  let body: Record<string, unknown> = {};

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "That request was not understood.", ok: false }, { headers, status: 400 });
  }

  try {
    const result =
      body.op === "update"
        ? await updateProfile({ id: body.id, patch: body.patch, secret: body.secret })
        : await hello({ backup: body.backup, id: body.id, name: body.name, secret: body.secret });

    return Response.json(result, { headers, status: result.ok ? 200 : result.fatal ? 403 : 400 });
  } catch (error) {
    console.error("profile failed", error);

    return Response.json({ error: "The game server is busy. Please try again.", ok: false }, { headers, status: 503 });
  }
}
