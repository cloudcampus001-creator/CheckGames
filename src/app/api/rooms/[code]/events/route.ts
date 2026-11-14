import type { RoomView } from "@/multiplayer/protocol";
import { subscribe } from "@/server/rooms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ code: string }> };

const headers = {
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream; charset=utf-8",
  // Stops proxies (nginx and friends) from holding the stream back.
  "X-Accel-Buffering": "no",
};

const HEARTBEAT_MS = 15_000;

/**
 * A live stream (server-sent events) of this player's view of the room.
 * A fresh view is pushed on every change. Problems are sent as a "fatal"
 * event rather than an error status so the browser stops retrying.
 */
export async function GET(request: Request, { params }: Context) {
  const { code } = await params;
  const url = new URL(request.url);
  const seatId = url.searchParams.get("seat") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const encoder = new TextEncoder();

  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      stop();
    },
    start(controller) {
      let finished = false;
      let unsubscribe = () => {};

      const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);

      function finish() {
        if (finished) {
          return;
        }

        finished = true;
        clearInterval(heartbeat);
        unsubscribe();

        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      function write(text: string) {
        if (finished) {
          return;
        }

        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          finish();
        }
      }

      function sendFatal(reason: string) {
        write(`event: fatal\ndata: ${JSON.stringify({ reason })}\n\n`);
        finish();
      }

      stop = finish;
      write("retry: 1500\n\n");

      const result = subscribe(
        code,
        seatId,
        token,
        (view: RoomView) => write(`event: state\ndata: ${JSON.stringify(view)}\n\n`),
        sendFatal,
      );

      if (!result.ok) {
        sendFatal(result.error);

        return;
      }

      unsubscribe = result.unsubscribe;
      request.signal.addEventListener("abort", finish);
    },
  });

  return new Response(stream, { headers });
}
