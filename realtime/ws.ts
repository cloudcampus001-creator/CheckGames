/**
 * A very small WebSocket server layer with no dependencies: it does the
 * handshake, reads and writes text frames, answers pings, and drops sockets
 * that stop answering. That is all the game needs.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket as NetSocket } from "node:net";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Nobody needs to send more than this in one message. */
const MAX_PAYLOAD = 64 * 1024;
const PING_EVERY_MS = 20_000;

export type WsSocket = {
  readonly request: IncomingMessage;
  send(text: string): void;
  close(code?: number): void;
  onMessage: ((text: string) => void) | null;
  onClose: (() => void) | null;
};

function frame(opcode: number, payload: Buffer) {
  const length = payload.length;
  let header: Buffer;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Accept WebSocket connections on an http server. `allow` can refuse a
 * connection (wrong origin, say); `onSocket` gets every accepted one.
 */
export function acceptWebSockets(
  server: Server,
  allow: (request: IncomingMessage) => boolean,
  onSocket: (socket: WsSocket) => void,
) {
  server.on("upgrade", (request: IncomingMessage, raw: Duplex) => {
    const key = request.headers["sec-websocket-key"];

    if (
      String(request.headers.upgrade ?? "").toLowerCase() !== "websocket" ||
      typeof key !== "string" ||
      !allow(request)
    ) {
      raw.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      raw.destroy();

      return;
    }

    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");

    raw.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    (raw as unknown as NetSocket).setNoDelay?.(true);

    let buffer: Buffer = Buffer.alloc(0);
    let pieces: Buffer[] = [];
    let pieceType = 0;
    let pieceSize = 0;
    let alive = true;
    let closed = false;

    const socket: WsSocket = {
      close(code = 1000) {
        if (closed) {
          return;
        }

        const reason = Buffer.alloc(2);

        reason.writeUInt16BE(code, 0);
        raw.write(frame(8, reason));
        raw.end();
        setTimeout(() => raw.destroy(), 1000).unref();
      },
      onClose: null,
      onMessage: null,
      request,
      send(text) {
        if (!closed && raw.writable) {
          raw.write(frame(1, Buffer.from(text, "utf8")));
        }
      },
    };

    const pinger = setInterval(() => {
      if (!alive) {
        raw.destroy();

        return;
      }

      alive = false;

      if (raw.writable) {
        raw.write(frame(9, Buffer.alloc(0)));
      }
    }, PING_EVERY_MS);

    pinger.unref();

    const finish = () => {
      if (closed) {
        return;
      }

      closed = true;
      clearInterval(pinger);
      socket.onClose?.();
    };

    raw.on("close", finish);
    raw.on("error", () => raw.destroy());

    function handle(fin: boolean, opcode: number, payload: Buffer) {
      if (opcode === 8) {
        socket.close(1000);

        return;
      }

      if (opcode === 9) {
        raw.write(frame(10, payload));

        return;
      }

      if (opcode === 10) {
        alive = true;

        return;
      }

      if (opcode === 1 || opcode === 2) {
        pieces = [payload];
        pieceType = opcode;
        pieceSize = payload.length;
      } else if (opcode === 0) {
        pieces.push(payload);
        pieceSize += payload.length;
      } else {
        return;
      }

      if (pieceSize > MAX_PAYLOAD) {
        socket.close(1009);

        return;
      }

      if (fin) {
        const whole = Buffer.concat(pieces);

        pieces = [];

        if (pieceType === 1) {
          socket.onMessage?.(whole.toString("utf8"));
        }
      }
    }

    raw.on("data", (chunk: Buffer) => {
      alive = true;
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        if (buffer.length < 2) {
          return;
        }

        const first = buffer[0];
        const second = buffer[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;

        if (length === 126) {
          if (buffer.length < 4) {
            return;
          }

          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) {
            return;
          }

          const big = buffer.readBigUInt64BE(2);

          if (big > BigInt(MAX_PAYLOAD)) {
            socket.close(1009);

            return;
          }

          length = Number(big);
          offset = 10;
        }

        if (length > MAX_PAYLOAD) {
          socket.close(1009);

          return;
        }

        // Browsers always mask what they send.
        if (!masked) {
          socket.close(1002);

          return;
        }

        if (buffer.length < offset + 4 + length) {
          return;
        }

        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));

        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }

        buffer = buffer.subarray(offset + 4 + length);
        handle(fin, opcode, payload);
      }
    });

    onSocket(socket);
  });
}
