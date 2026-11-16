# Cheque-games

The Cameroonian card game: finish all your cards, say **check** when you have
one left, and win with **games** when you play the last one.

One person creates a game and shares a 4-letter code (or taps **Invite on
WhatsApp**). That person is the host: they choose the rules, add computer
players and start the game.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Friends on the same network open `http://YOUR-COMPUTER-IP:3000` (not
`localhost`) and type the code. Add that address to `allowedDevOrigins` in
`next.config.ts` if the dev server complains.

## Make it truly realtime (recommended)

Without a realtime server the page asks the website about every half second.
That works anywhere (including Vercel alone) but each move can take a moment to
show up. With the realtime server every move, card, chat line and sticker is
**pushed to everybody the instant it happens**, and bots play on exact timers.

The realtime server is `realtime/server.ts`. It uses the same rules as the
website and has no extra packages. It keeps games in memory, so it needs no
database.

1. Start it: `npm run realtime` (it listens on port 4000, or on `PORT`).
2. Tell the website where it is, with the variable
   `NEXT_PUBLIC_REALTIME_URL` (see `.env.example`):
   - same computer: put `NEXT_PUBLIC_REALTIME_URL=http://localhost:4000` in a
     file called `.env.local`, then restart `npm run dev`.
   - friends on your network: use `http://YOUR-COMPUTER-IP:4000`.
   - online: deploy the same project on a host that keeps a program running
     (Render, Railway, Fly.io...). Build command `npm install`, start command
     `npm run realtime`. Then, in Vercel, add `NEXT_PUBLIC_REALTIME_URL` with
     the address it gives you (`https://...`) and **redeploy**. Optional: on
     the realtime host set `ALLOWED_ORIGINS=https://your-game.vercel.app` so
     only your website can connect.
3. Open `http://localhost:4000` (or your host's address) in a browser: it must
   answer `{"ok":true,...}`.

Good to know: free hosts put idle programs to sleep, so the first connection
after a quiet hour can take half a minute. If the realtime server restarts, the
games on it start over. Leave `NEXT_PUBLIC_REALTIME_URL` empty and the game goes
back to the plain version by itself.

### Plain version on Vercel: make it faster

- In your Upstash database and in Vercel (Settings > Functions > Function
  Region) pick regions **near each other and near your players** (for players in
  Cameroon: Paris, Frankfurt or Cape Town; Upstash: the nearest to it).
- Open `/api/health` to check: it must say `"storage":"redis"`.

## Playing

- On your turn play a card with the same number or sign as the centre card, or
  take a card from the bank (any time; it ends your turn). Your card appears on
  the pile the moment you tap it.
- A bank that runs out is refilled by mixing the pile (the centre card stays).
- Down to one card? You are **on check**: announced by itself. Play your last
  card: **GAMES!**

### Special cards

| Card | What it does |
| --- | --- |
| **A** | The next player is stopped; the one after plays. **With two players you play again, so an A cannot be your winning card: you take a card from the bank and stay on check.** |
| **2** | Goes on anything: **On top** (it becomes the centre card) or **Under** (the centre card stays). |
| **7** | The next player takes **2** from the bank. |
| **Joker** | The next player takes **4**. |
| **J** | Goes on anything. You name a sign; the next player must play that sign, a **2**, a **J**, **or the joker of that colour: the red joker for hearts and diamonds, the black joker for clubs and spades.** |

- Hit by a 7 or a joker you can answer with a 7 or a joker (any sign, any colour);
  the total grows for the next player. Otherwise you take everything owed.
- Otherwise the red joker only goes on a red card and the black joker on a black card.

### How a set ends (the host chooses)

- **Stop:** the others finish the round; the first one out wins. Several out in
  the same round? Each takes 2 cards and they play it off.
- **Keep going:** everybody is ranked 1st, 2nd, 3rd...
- **Eliminate the loser:** after each set the last player is out, until two are
  left (the final). Then everybody can play again.

## Together with friends

- **Chat** in the lobby and during the game (💬), with one-tap phrases and unread
  counter. New lines also pop up as a bubble over the player who wrote them.
- **Stickers** (😀): 12 emojis and 4 badges (GG!, WOW!...) that float up from the
  player with a different animation each time. Bots throw some too.
- **Ready** buttons in the lobby, a **host crown** to hand the table over, and
  **Invite on WhatsApp**.
- **Votes:** anybody can call a vote on the number of cards, jokers or how a game
  ends (the result is applied automatically), vote to **remove a player** (3 or
  more players), or vote for a **rematch** after a game. Everybody who is there
  votes, or time runs out (30 s).
- **Back to the lobby by itself** a few seconds after a game, with a countdown
  (the host can switch it off). Not during an elimination tournament.
- **Scoreboard:** games won in the room (🏆) show in the lobby and on the results.
- **Sounds** made on the spot (no files), a chime and buzz on your turn, and the
  tab title says "Your turn!" when the page is in the background. 🔊 mutes it.

## Tests

```bash
npm test
```

Rules (every special card, 900 simulated games), rooms, chat/stickers/votes/auto
return (`src/server/social.test.ts`), the network layer, and real games over
real WebSockets against the realtime server.

## Where things are

| File | What it does |
| --- | --- |
| `src/cheque-games/engine.ts` | All the rules. No React, easy to test. |
| `src/server/rooms.ts` | A room as plain functions: codes, host controls, bots, votes, auto return. |
| `src/server/social.ts` | Chat, stickers, ready, wins and votes. |
| `src/server/store.ts`, `service.ts` | Rooms in Upstash Redis (or memory) for the plain version. |
| `realtime/` | The realtime server (`server.ts`), its tiny WebSocket layer (`ws.ts`) and start file. |
| `src/multiplayer/rt.ts`, `useRoom.ts` | How the browser follows a game (push or ask). |
| `src/multiplayer/Table.tsx`, `Lobby.tsx`, `ResultsOverlay.tsx` | The screens. |
| `src/multiplayer/Chat.tsx`, `Reactions.tsx`, `VotePanel.tsx`, `Dock.tsx` | Chat, stickers, votes, buttons. |
| `src/multiplayer/sound.ts` | The sound effects. |
