/**
 * A tiny stand-in for Upstash's Redis REST API, for tests only. It understands
 * exactly the commands store.ts sends (GET, SET with NX/EX, DEL, EVAL of the
 * save script) and works like Redis does: each command is applied one at a
 * time, so the compare-and-save is atomic.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SAVE_SCRIPT } from "../store";

export type FakeUpstash = {
  /** Commands that were refused because the revision had changed. */
  conflicts: () => number;
  close: () => Promise<void>;
  /** Answer the next `count` requests with a server error. */
  failNext: (count: number) => void;
  /** How many commands were received. */
  commands: () => number;
  /** Wait up to this many ms (random) before answering, to mix requests up. */
  jitter: (ms: number) => void;
  keys: () => string[];
  token: string;
  url: string;
};

export async function startFakeUpstash(token = "test-token"): Promise<FakeUpstash> {
  const data = new Map<string, string>();
  let conflicts = 0;
  let commands = 0;
  let failures = 0;
  let jitter = 0;

  const server: Server = createServer((request, response) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const reply = (status: number, payload: unknown) => {
        const send = () => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };

        if (jitter > 0) {
          setTimeout(send, Math.random() * jitter);
        } else {
          send();
        }
      };

      if (request.headers.authorization !== `Bearer ${token}`) {
        return reply(401, { error: "Unauthorized" });
      }

      if (failures > 0) {
        failures -= 1;

        return reply(500, { error: "ERR server hiccup" });
      }

      let args: (string | number)[];

      try {
        args = JSON.parse(body);
      } catch {
        return reply(400, { error: "ERR bad body" });
      }

      commands += 1;

      const [name, ...rest] = args;
      const command = String(name).toUpperCase();

      // Redis does one command at a time: this whole block runs without a pause.
      if (command === "GET") {
        return reply(200, { result: data.get(String(rest[0])) ?? null });
      }

      if (command === "SET") {
        const [key, value, ...options] = rest.map(String);
        const nx = options.map((o) => o.toUpperCase()).includes("NX");

        if (nx && data.has(key)) {
          return reply(200, { result: null });
        }

        data.set(key, value);

        return reply(200, { result: "OK" });
      }

      if (command === "DEL") {
        return reply(200, { result: data.delete(String(rest[0])) ? 1 : 0 });
      }

      if (command === "EVAL") {
        const [script, , key, expected, value] = rest.map(String);

        if (script !== SAVE_SCRIPT) {
          return reply(400, { error: "ERR unknown script" });
        }

        const current = data.get(key);

        if (current === undefined) {
          return reply(200, { result: -1 });
        }

        if (current.slice(0, current.indexOf("|")) !== expected) {
          conflicts += 1;

          return reply(200, { result: 0 });
        }

        data.set(key, value);

        return reply(200, { result: 1 });
      }

      return reply(400, { error: `ERR unknown command ${command}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    commands: () => commands,
    conflicts: () => conflicts,
    failNext: (count) => {
      failures = count;
    },
    jitter: (ms) => {
      jitter = ms;
    },
    keys: () => [...data.keys()],
    token,
    url: `http://127.0.0.1:${port}`,
  };
}
