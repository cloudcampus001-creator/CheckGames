# Cheque-games

The Cameroonian card game: finish all your cards, say **check** when you have
one left, and win with **games** when you play the last one.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Friends on the same network open `http://YOUR-COMPUTER-IP:3000` (not
`localhost`). Add that address to `allowedDevOrigins` in `next.config.ts` if the
dev server complains.

## Make it truly realtime (recommended)

Without a realtime server the page asks the website about every half second.
With the realtime server (`realtime/`) every move, chat line and sticker is
**pushed to everybody the instant it happens**, bots and turn clocks run on exact
timers, and matchmaking is live. It needs no extra packages.

1. Start it: `npm run realtime` (port 4000, or `PORT`).
2. Tell the website where it is with `NEXT_PUBLIC_REALTIME_URL` (see
   `.env.example`): `http://localhost:4000` on your computer, or the `https://`
   address of the host you deployed it to (Render, Railway, Fly.io...). In Vercel
   add the variable and **redeploy**.
3. Open that address in a browser: it must answer `{"ok":true,...}`.

**"Could not reach the game server" on some phones?** That means the phone could
not connect, usually because (a) its network blocks WebSockets, or (b) the free
server was asleep. The game now handles both by itself: it falls back to plain
requests to the same server (so it works on networks that block WebSockets) and
it says "Waking up the game server..." while a sleeping server wakes up, which
can take up to a minute the first time. To avoid the wait, keep it awake with a
free pinger (for example cron-job.org calling your server's address every 10
minutes) or use a paid plan. Always use the `https://` address.

**Profiles and the leaderboard** are kept on the realtime server. For them to
survive restarts, set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` on
the realtime server (a free Upstash database is enough). Without them they live
in memory, but each device remembers its own profile and gives it back to the
server when it returns.

### Plain version on Vercel

Set up Upstash Redis as before (see `/api/health`), and pick a Vercel function
region and an Upstash region near each other and near your players (for
Cameroon: Paris, Frankfurt or Cape Town). Profiles, matchmaking and the
leaderboard work here too, in the same database.

## Playing

- On your turn play a card with the same number or sign as the centre card, or
  take a card from the bank (any time; it ends your turn).
- Down to one card? You are **on check**, announced by itself. Play your last
  card: **GAMES!**

### Special cards

| Card | What it does |
| --- | --- |
| **A** | The next player is stopped. **With two players you play again, so an A cannot be your winning card: you take a card and stay on check.** |
| **2** | Goes on anything: **On top** or **Under** (the centre card stays). |
| **7** | The next player takes **2**. |
| **Joker** | The next player takes **4**. |
| **J** | Goes on anything. You name a sign; the next player must play that sign, a **2**, a **J**, **or the joker of that colour** (red joker for hearts and diamonds, black joker for clubs and spades). |

Hit by a 7 or joker you can answer with a 7 or joker and the total grows.

### Doubling (the host switches it on, or the table votes for it)

Play 2 to 4 cards of the **same number or letter** together. The **bottom** card
must match the centre card (same sign or same number); the others go on top in
the order you choose, and the last one becomes the centre card. Example: the
centre is a spade and you hold the 4 of hearts and the 4 of spades: you can play
both, with the 4 of spades at the bottom. If the centre is another 4, either
order works.

How to play it: **hold a card for a moment** (it lifts), **tap the other cards** of
the same number to add them (tap a lifted card again to put it back; a card that
does not belong makes the stack shake), then **drag the stack up to the table** (or
press *Play together*). Effects add up: two 7s make the next player take 4, two
aces stop two players, two jacks ask for one sign. Jokers are played alone.

## Profiles, levels and online play

- Every device is **a player**: it gets a profile with a name and a face, and
  keeps its **stats** (games, wins, losses, streaks, cards played and taken,
  7s/aces/jacks, clocks that ran out, per-mode results), **XP and levels**, an
  online **rating with tiers** (Bronze to Legend), **badges**, a day streak and the
  last games. Open it from the home screen (**Profile**).
- **Play online** finds real players: you say which table sizes and clock you like,
  and the game matches you with players of a similar rating (the range widens the
  longer you wait), makes a full table as soon as there are enough players, starts
  a smaller one after a few seconds, and if nobody comes (about 20 s) it gives you
  the computer instead. The table is set up for you and the game starts at once.
- The **leaderboard** shows the players with the most XP.
- Make it yours (Profile > *Make it yours*): board colours and your own colour,
  board styles, card styles, four-colour deck, card backs, title and text fonts,
  and a "fewer effects" mode for slow phones. It is remembered with your profile.

## Together with friends

- **Time to play** (host): off, 5, 10, 15, 30 seconds or your own. The last 5
  seconds are counted out on the screen; when time runs out the player takes a
  card and the turn passes. After 3 times in a row the table plays for them until
  they tap *I am back*.
- The host can **remove a player during a game** (the ✕ on their seat); their cards
  go back to the bank.
- **After a game nobody walks out** (private rooms): play again or go back to the
  lobby, by the host's choice, a vote, or the automatic return.
- **Votes:** the table votes on the rules (cards, jokers, how a game ends,
  doubling), on removing a player, on a rematch, and the host can **write his own
  question and choices**; the result is announced in the chat (he acts on it
  himself).
- Chat, stickers, ready buttons, host crown, invite on WhatsApp, sounds, scoreboard.

## Tests

```bash
npm test
```

## Where things are

| File | What it does |
| --- | --- |
| `src/cheque-games/engine.ts` | All the rules (doubling included). |
| `src/server/rooms.ts`, `social.ts` | A room: codes, host controls, bots, clocks, votes, results. |
| `src/server/matchmaking.ts`, `matchService.ts` | The smart matching, and the queue over plain requests. |
| `src/server/profiles.ts`, `profileStore.ts` | Profiles, stats, leaderboard storage. |
| `src/multiplayer/profile.ts`, `prefs.ts` | Levels, ratings, badges; the look options. |
| `realtime/` | The realtime server, with a WebSocket and a plain-request mode. |
| `src/multiplayer/rt.ts` | The browser side (WebSocket, falling back by itself). |
| `src/multiplayer/Table.tsx`, `Lobby.tsx`, `OnlineScreen.tsx`, `ProfileScreen.tsx` | The screens. |
