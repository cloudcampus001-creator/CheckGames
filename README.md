# Cheque-games

The Cameroonian card game: finish all your cards, say **check** when you have
one left, and win with **games** when you play the last one.

Play with friends on the same network. One person creates a game and shares a
4-letter code. That person is the host: they choose the rules, add computer
players and start the game.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer (the LTS version is fine).

```bash
cd cheque-games
npm install
npm run dev
```

### Playing with friends on your network

1. On the computer that runs the game, open the game with its **network
   address**, not `localhost`. For you that is:

   **http://169.254.197.238:3000**

   (If you open it as `localhost`, the lobby warns you, because the share link
   would then only work on your own computer.)
2. Click **Create game**. You get a code such as `K7QD` and a link.
3. Your friends open the same address in their browser, type the code under
   **Join a game** (or open your link), and enter their name.
4. In the lobby you set the rules, click **+ Add bot** for computer players,
   and press **Start the game**.

Things that can get in the way:

- **Same network.** Everyone must be on the same Wi-Fi or cable network as the
  computer running the game. An address starting with `169.254` usually means
  the computer has no router giving it an address, so it only works for a
  device connected straight to it. On a normal Wi-Fi network run `ipconfig`
  (Windows) or `ifconfig` / `ip a` (Mac / Linux) and use the address it shows
  instead. Then add it to `allowedDevOrigins` in `next.config.ts`.
- **Firewall.** The first time, Windows may ask whether Node.js may accept
  connections. Allow it on private networks.
- **Port 3000** must be free. To use another port: `npm run dev -- -p 3001`.

For a faster, production-style run: `npm run build` then `npm start`.

### Practising alone

On the start page, **Play against 2 bots** makes a normal game with two bots
and starts it straight away.

## How a game works

- Everyone gets the same number of cards (the host chooses how many).
- One card goes face up in the middle. The rest is the **bank**.
- On your turn you either:
  - **play** a card with the same **number or letter** (character) or the same
    **sign** (suit) as the centre card. Tap it, or flick it upward; or
  - **take a card from the bank.** This is always allowed on your turn, even if
    you have a card you could play. Taking a card ends your turn.
- When the **bank is finished**, all the cards under the centre card are
  **mixed** and become the new bank. The centre card stays.
- Down to one card? Press **CHECK!** Everyone else sees your seat **blink**
  and a banner announces it.
- Play your last card: **GAMES!**

### Special cards

| Card | What it does |
| --- | --- |
| **A** | The next player is stopped (they get a STOPPED badge). The one after plays. With two players you play again. |
| **2** | Goes on anything. You choose **On top** (it becomes the centre card) or **Under** (the centre card stays). |
| **7** | The next player takes **2** from the bank. |
| **Joker** | The next player takes **4**. |
| **J** | Goes on anything. You name a sign; the next player must play that sign, a **2** or a **J**. |

- If you are hit by a 7 or a joker you can answer with a 7 or a joker (any
  sign, any colour) and the total grows (2 + 2 = 4, 2 + 4 = 6, …) for the next
  player. Otherwise you take everything owed from the bank.
- Outside of that, the red joker only goes on a red card (hearts or diamonds)
  and the black joker on a black card (clubs or spades). Only a red card goes
  on a red joker, and a black card on a black joker.
- When you take a card from the bank you see it **rise, turn over and slide
  into your hand**. Others see a face-down card fly to you.

### How a set ends (the host chooses)

- **Stop:** the set ends as soon as one player plays their last card.
- **Keep going:** the others carry on until everybody is ranked: 1st, 2nd, 3rd…
  A finished player watches. Everyone sees the ranking at the end.
- **Eliminate the loser** (only with *Keep going*): after each set the last
  player is out for the next one, until two are left. That set is the
  **final**. After the final's winner, the host can press **Play again** and
  everyone, the eliminated included, is back.

The host can also remove players in the lobby, swap a player who has dropped
off for a bot during a game, and send everyone back to the lobby afterwards.
If someone closes the page they can come back to the same seat by opening the
same link in the same browser.

## What you see on the table

- Played cards fly from where they were (your hand, or the other player's
  seat) onto the centre pile.
- The pile is untidy like a real one: every card lies at its own angle, so the
  cards underneath show at the edges. Everyone sees the same pile.
- A card taken from the bank flies to whoever took it.
- When the bank is finished, the pile's cards gather, swing across to mix, and
  land on the bank.

## Where things are

| File | What it does |
| --- | --- |
| `src/cheque-games/engine.ts` | All the rules, special cards included. No React, easy to test. |
| `src/server/rooms.ts` | Rooms, codes, host controls, bots. Each player only ever receives their own cards. |
| `src/app/api/rooms/...` | The network side: create, join, actions and the live update stream. |
| `src/multiplayer/Table.tsx` | The table: seats, bank, pile, your hand. |
| `src/multiplayer/CentrePile.tsx` | The untidy centre pile and card flights onto it. |
| `src/multiplayer/FlightLayer.tsx` | Cards flying from the bank, and the mixing. |
| `src/multiplayer/flights.ts` | Pile angles and screen-position helpers. |
| `src/multiplayer/Choosers.tsx` | The "on top / under" question for a 2 and the sign picker for a J. |
| `src/multiplayer/ResultsOverlay.tsx` | End of a set: ranking, who is out, the champion, host buttons. |
| `src/multiplayer/Lobby.tsx`, `HomeScreen.tsx`, `RoomScreen.tsx` | The other screens. The lobby has the host's rules. |
| `src/components/PlayingCard.tsx`, `PlayingCardFan.tsx` | Your card components. |
| `public/experiments/` | **Placeholder** court cards and card back. |

Your two card components have small additions: `PlayingCard` can draw the red
and black **joker**; `PlayingCardFan` names jokers for screen readers, can dim
cards you cannot play (`dimmedIds`) and can keep a card invisible while it is
still flying in (`hiddenIds`). Each card button also has a `data-card-id`
attribute, so the table knows where a card was on screen when you played it.

## Replace the placeholder art

The jack, queen and king pictures in `public/experiments/courts/` (named like
`QH.png`: rank, then suit letter) and `public/experiments/card-back.png` are
simple generated stand-ins. Drop your own images in with the same file names
and they are used automatically.

## Tests

```bash
npm test
```

Runs the rules (every special card, both ways of ending, and 900 simulated
games with jokers), the room server (host settings, privacy of hands and of
drawn cards, kicking, leaving, reconnecting, ranking, elimination and the final,
full games with people and bots) and the network layer.

## Rules I had to decide (change them in `engine.ts`)

- Players go one after another, one card per turn (clockwise).
- Taking a card from the bank ends your turn, even if you took it by choice.
- The bank is only open on your own turn.
- If the bank is empty and there is nothing under the centre card to mix in,
  you must play if you can. If you cannot, your turn passes.
- The very first centre card is never a special card (A, 2, 7, J, joker).
- Under a 7 or joker attack you may only answer with a 7 or a joker. A 2 or a J
  cannot stop it.
- A sign asked for by a J stays until a card lands **on top**. A 2 slipped
  **under** does not cancel it.
- A joker in the centre accepts only cards of its colour (or a 2, a J, or its
  own colour's joker), and a joker goes on a 7 whatever the colours.
- If the bank cannot give all the cards owed, you take what there is.
- If nobody can move any more (empty bank, no playable cards), the set ends and
  the player with the fewest cards ranks highest.
- Forgetting to say check has no penalty yet.
- With two players, an Ace makes you play again.
- Jokers are on by default; the host can switch them off.

## Good to know

- Games live in the server's memory. Restarting the server clears them, and an
  empty game is removed after 30 minutes.
- Run one server only (not several copies), because the games are kept in that
  one process.
