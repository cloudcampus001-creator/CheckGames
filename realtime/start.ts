/**
 * Starts the realtime server:  npm run realtime
 *
 *   PORT              port to listen on (default 4000; hosts like Render set it for you)
 *   ALLOWED_ORIGINS   optional, comma separated, e.g. https://my-game.vercel.app
 *                     When set, only pages from these addresses may connect.
 */
import { startServer } from "./server";

const port = Number(process.env.PORT ?? 4000);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

startServer(port, { allowedOrigins }).then(
  (running) => {
    console.log(`Cheque-games realtime server is running on port ${running.port}.`);
    console.log("Open http://localhost:" + running.port + " to check it is on.");
  },
  (error) => {
    console.error("Could not start the realtime server:", error);
    process.exit(1);
  },
);
