import assert from "node:assert/strict";
import {
  type Card,
  type EndMode,
  type GameState,
  type JokerCard,
  type Rank,
  type StandardCard,
  type Suit,
} from "../cheque-games/engine";
import type { RoomView, SeatView } from "../multiplayer/protocol";
import {
  applyAction,
  configureRooms,
  createRoom,
  joinRoom,
  peekRoom,
  resetRooms,
  subscribe,
} from "./rooms";

configureRooms({ botDelayMax: 2, botDelayMin: 0 });

type Client = {
  seatId: string;
  token: string;
  view: RoomView | null;
  closed: string | null;
  disconnect: () => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, label: string, ms = 8000) {
  const started = Date.now();

  while (!condition()) {
    if (Date.now() - started > ms) {
      throw new Error(`Timed out waiting for: ${label}`);
    }

    await sleep(1);
  }
}

function connect(code: string, seatId: string, token: string): Client {
  const client: Client = {
    closed: null,
    disconnect: () => {},
    seatId,
    token,
    view: null,
  };
  const result = subscribe(
    code,
    seatId,
    token,
    (view) => {
      client.view = view;
    },
    (reason) => {
      client.closed = reason;
    },
  );

  assert.ok(result.ok, "subscribe should work");

  if (result.ok) {
    client.disconnect = result.unsubscribe;
  }

  return client;
}

function act(client: Client, code: string, action: object) {
  return applyAction(code, client.seatId, client.token, action);
}

/** Humans play the simplest legal move each turn until the game is over. */
async function playOut(code: string, humans: Client[]) {
  let steps = 0;

  for (;;) {
    await waitFor(
      () =>
        humans[0].view?.phase === "finished" ||
        humans.some((h) => h.view?.game?.currentSeatId === h.seatId),
      "a human's turn or the end of the game",
    );

    if (humans[0].view?.phase === "finished") {
      return;
    }

    const me = humans.find((h) => h.view?.game?.currentSeatId === h.seatId);
    const game = me?.view?.game;

    assert.ok(me && game);

    if (game.canCheck) {
      assert.ok(act(me, code, { type: "check" }).ok, "check should be allowed");
    }

    // The server tells us which cards are legal right now. A jack needs a sign.
    const playable = game.hand.find((card) => game.playableIds.includes(card.id));
    const result = playable
      ? act(me, code, {
          cardId: playable.id,
          suit: playable.rank === "J" ? "hearts" : undefined,
          type: "play",
        })
      : act(me, code, { type: "draw" });

    assert.ok(result.ok, `move should be accepted: ${JSON.stringify(result)}`);
    steps += 1;
    assert.ok(steps < 5000, "game should finish");
  }
}

function newTable(humanNames: string[], bots: number) {
  const created = createRoom(humanNames[0]);
  const code = created.code;
  const host = connect(code, created.seatId, created.token);
  const clients = [host];

  for (const name of humanNames.slice(1)) {
    const joined = joinRoom(code, name);

    assert.ok(joined.ok);

    if (joined.ok) {
      clients.push(connect(code, joined.seatId, joined.token));
    }
  }

  for (let i = 0; i < bots; i++) {
    assert.ok(act(host, code, { type: "addBot" }).ok);
  }

  return { clients, code, host };
}

async function main() {
  // --- creating and joining ---------------------------------------------------
  {
    const { clients, code, host } = newTable(["Amina", "Paul"], 0);

    assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/, "four unambiguous characters");
    assert.equal(host.view?.seats.length, 2);
    assert.equal(host.view?.hostId, host.seatId);
    assert.equal(host.view?.phase, "lobby");

    // lower-case codes work, unknown codes do not
    assert.ok(joinRoom(code.toLowerCase(), "Lowercase").ok);
    assert.equal(joinRoom("ZZZZ", "Nobody").ok, false);

    // same name gets a number so seats stay tell-apart-able
    const twin = joinRoom(code, "Amina");

    assert.ok(twin.ok);
    assert.equal(host.view?.seats.filter((s) => s.name.startsWith("Amina")).length, 2);

    // wrong token and wrong seat are rejected
    assert.equal(applyAction(code, host.seatId, "nope", { type: "addBot" }).ok, false);
    assert.equal(applyAction(code, "nobody", host.token, { type: "addBot" }).ok, false);

    // only the host runs the lobby
    const guest = clients[1];

    for (const action of [
      { type: "addBot" },
      { type: "start" },
      { cardsPerPlayer: 3, type: "setSettings" },
      { seatId: host.seatId, type: "removeSeat" },
    ]) {
      const result = act(guest, code, action);

      assert.equal(result.ok, false, `guest must not ${action.type}`);
    }

    // reconnecting with the saved token returns the same seat
    const again = joinRoom(code, "Whatever", guest.token);

    assert.ok(again.ok && again.seatId === guest.seatId);

    // the host chooses the rules; values are clamped to what the deck allows
    assert.ok(act(host, code, { cardsPerPlayer: 99, type: "setSettings" }).ok);
    assert.equal(
      host.view?.settings.cardsPerPlayer,
      host.view?.maxCardsPerPlayer,
    );
    assert.ok(act(host, code, { cardsPerPlayer: 4, type: "setSettings" }).ok);
    assert.equal(host.view?.settings.cardsPerPlayer, 4);

    // defaults: jokers in, game stops when one games, no elimination
    assert.deepEqual(host.view?.settings, {
      cardsPerPlayer: 4,
      elimination: false,
      endMode: "first",
      jokers: true,
    });

    // elimination only makes sense when everybody gets ranked
    assert.ok(act(host, code, { elimination: true, type: "setSettings" }).ok);
    assert.equal(host.view?.settings.elimination, false, "off while the game stops at the first winner");
    assert.ok(act(host, code, { endMode: "ranking", type: "setSettings" }).ok);
    assert.ok(act(host, code, { elimination: true, type: "setSettings" }).ok);
    assert.equal(host.view?.settings.elimination, true);
    assert.ok(act(host, code, { endMode: "first", type: "setSettings" }).ok);
    assert.equal(host.view?.settings.elimination, false, "switching back turns it off again");
    assert.ok(act(host, code, { jokers: false, type: "setSettings" }).ok);
    assert.equal(host.view?.settings.jokers, false);
    assert.equal(host.view?.settings.cardsPerPlayer, 4, "other settings stay put");

    // nonsense is refused, and guests cannot touch any rule
    assert.equal(act(host, code, { endMode: "whatever", type: "setSettings" }).ok, false);
    assert.equal(act(host, code, { jokers: "yes", type: "setSettings" }).ok, false);
    assert.equal(act(host, code, { elimination: 1, type: "setSettings" }).ok, false);
    assert.equal(act(guest, code, { endMode: "ranking", type: "setSettings" }).ok, false);
    assert.equal(act(guest, code, { jokers: true, type: "setSettings" }).ok, false);

    // with jokers the deck is 54, so a hand can be one bigger
    assert.ok(act(host, code, { cardsPerPlayer: 99, type: "setSettings" }).ok);
    assert.equal(host.view?.maxCardsPerPlayer, 12, "52 cards (no jokers) and 4 seats: 12 each");
    assert.ok(act(host, code, { jokers: true, type: "setSettings" }).ok);
    assert.equal(host.view?.maxCardsPerPlayer, 13, "54 cards and 4 seats: 13 each");
    resetRooms();
  }

  // --- starting needs two seats -------------------------------------------------
  {
    const created = createRoom("Solo");
    const solo = connect(created.code, created.seatId, created.token);

    assert.equal(act(solo, created.code, { type: "start" }).ok, false);
    assert.ok(act(solo, created.code, { type: "addBot" }).ok);
    assert.ok(act(solo, created.code, { type: "start" }).ok);
    assert.equal(joinRoom(created.code, "Late").ok, false, "no joining mid-game");

    resetRooms();
  }

  // --- privacy ---------------------------------------------------------------
  {
    const { clients, code, host } = newTable(["Amina", "Paul"], 2);

    assert.ok(act(host, code, { cardsPerPlayer: 5, type: "setSettings" }).ok);
    assert.ok(act(host, code, { type: "start" }).ok);

    const secretGame = peekRoom(code)?.game;

    assert.ok(secretGame);

    for (const client of clients) {
      const json = JSON.stringify(client.view);
      const ownCards: string[] = secretGame.players
        .filter((p) => p.id === client.seatId)
        .flatMap((p) => p.hand.map((card) => card.id));
      const shownCards: string[] = (client.view?.game?.hand ?? []).map(
        (card) => card.id,
      );

      assert.equal(shownCards.length, 5);
      assert.deepEqual(shownCards, ownCards);

      for (const other of secretGame.players) {
        if (other.id === client.seatId) {
          continue;
        }

        for (const card of other.hand) {
          assert.ok(
            !json.includes(`"${card.id}"`),
            `${client.seatId} must not see ${card.id}`,
          );
        }
      }

      assert.ok(!json.includes('"token"'), "no tokens in views");
    }

    assert.equal(clients[0].view?.seats.find((s) => s.kind === "bot")?.handCount, 5);
    resetRooms();
  }

  // --- full games: humans and bots, various sizes, both ways of ending ----------------
  for (const [humans, bots, cards, mode] of [
    [1, 1, 5, "first"],
    [2, 0, 7, "first"],
    [2, 3, 5, "ranking"],
    [3, 2, 3, "ranking"],
    [1, 9, 4, "first"],
    [1, 3, 5, "ranking"],
  ] as const) {
    const names = Array.from({ length: humans }, (_, i) => `Human${i + 1}`);
    const { clients, code, host } = newTable(names, bots);

    assert.ok(
      act(host, code, { cardsPerPlayer: cards, endMode: mode, type: "setSettings" }).ok,
    );
    assert.ok(act(host, code, { type: "start" }).ok);
    await playOut(code, clients);

    const room = peekRoom(code);
    const players = room?.game?.players ?? [];
    const winner = players.find((p) => p.id === room?.game?.winner);

    assert.equal(room?.phase, "finished");
    assert.ok(room?.game?.over);
    assert.ok(winner && winner.hand.length === 0, "winner has no cards left");
    assert.equal(
      room?.game
        ? room.game.bank.length +
            room.game.pile.length +
            players.reduce((n, p) => n + p.hand.length, 0)
        : 0,
      54,
      "all 54 cards accounted for (jokers are on by default)",
    );

    const view = clients[0].view?.game;

    assert.ok(view?.winnerId, "everyone is told who won");
    assert.equal(view.over, true);
    assert.equal(view.standings[0].seatId, view.winnerId);
    assert.deepEqual(
      view.standings.map((s) => s.rank),
      view.standings.map((_, i) => i + 1),
    );

    if (mode === "ranking") {
      assert.equal(view.standings.length, players.length, "everybody is ranked");
      assert.deepEqual(
        clients[0].view?.seats.map((s) => s.rank).sort(),
        players.map((_, i) => i + 1),
        "every seat shows its place",
      );
    }

    // back to the lobby keeps the table and lets the host go again
    if (humans > 1) {
      assert.equal(
        act(clients[1], code, { type: "backToLobby" }).ok,
        false,
        "only the host can reopen the lobby",
      );
    }
    assert.ok(act(host, code, { type: "backToLobby" }).ok);
    assert.equal(host.view?.phase, "lobby");
    assert.ok(act(host, code, { type: "start" }).ok);
    assert.equal(host.view?.phase, "playing");

    resetRooms();
  }

  // --- kicking in the lobby -----------------------------------------------------
  {
    const { clients, code, host } = newTable(["Amina", "Paul"], 1);
    const paul = clients[1];

    assert.ok(act(host, code, { seatId: paul.seatId, type: "removeSeat" }).ok);
    assert.ok(paul.closed, "kicked player's stream is closed");
    assert.equal(host.view?.seats.length, 2);
    assert.equal(act(paul, code, { type: "draw" }).ok, false, "kicked token is dead");

    const bot = host.view?.seats.find((s) => s.kind === "bot");

    assert.ok(bot);
    assert.ok(act(host, code, { seatId: bot.id, type: "removeSeat" }).ok);
    assert.equal(host.view?.seats.length, 1);

    resetRooms();
  }

  // --- leaving: host passes on, game goes on with a bot ---------------------------------
  {
    const { clients, code, host } = newTable(["Amina", "Paul"], 1);
    const paul = clients[1];

    assert.ok(act(host, code, { cardsPerPlayer: 4, type: "setSettings" }).ok);
    assert.ok(act(host, code, { type: "start" }).ok);
    assert.ok(act(host, code, { type: "leave" }).ok);
    assert.ok(host.closed);
    assert.equal(paul.view?.hostId, paul.seatId, "host passes to the next human");
    assert.equal(paul.view?.seats.filter((s) => s.kind === "bot").length, 2);

    await playOut(code, [paul]);
    assert.equal(peekRoom(code)?.phase, "finished");

    // the last human leaving closes the room
    assert.ok(act(paul, code, { type: "leave" }).ok);
    assert.equal(peekRoom(code), undefined);
    assert.equal(joinRoom(code, "Late").ok, false);
  }

  // --- host swaps a stalled human for a bot --------------------------------------------
  {
    const { clients, code, host } = newTable(["Amina", "Paul"], 0);
    const paul = clients[1];

    assert.ok(act(host, code, { type: "start" }).ok);
    paul.disconnect();
    assert.equal(
      host.view?.seats.find((s) => s.id === paul.seatId)?.connected,
      false,
      "disconnected players are shown as offline",
    );

    assert.equal(act(paul, code, { type: "leave" }).ok, true, "token still valid after disconnect");

    resetRooms();
  }
  {
    const { clients, code, host } = newTable(["Amina", "Paul"], 0);
    const paul = clients[1];

    assert.equal(act(paul, code, { seatId: host.seatId, type: "replaceWithBot" }).ok, false);
    assert.ok(act(host, code, { type: "start" }).ok);
    assert.equal(act(paul, code, { seatId: host.seatId, type: "replaceWithBot" }).ok, false);
    assert.equal(act(host, code, { seatId: host.seatId, type: "replaceWithBot" }).ok, false);
    assert.ok(act(host, code, { seatId: paul.seatId, type: "replaceWithBot" }).ok);
    assert.ok(paul.closed);
    await playOut(code, [host]);
    assert.equal(peekRoom(code)?.phase, "finished");

    resetRooms();
  }

  // --- illegal moves are refused with a reason ------------------------------------------
  {
    const { clients, code, host } = newTable(["Amina", "Paul"], 0);

    assert.ok(act(host, code, { type: "start" }).ok);

    const room = peekRoom(code);

    assert.ok(room?.game);

    const mover = clients.find((c) => c.seatId === room.game?.players[room.game.current].id);
    const waiter = clients.find((c) => c !== mover);

    assert.ok(mover && waiter);

    const waiting = act(waiter, code, { cardId: "whatever", type: "play" });

    assert.ok(!waiting.ok && /turn/i.test(waiting.error));
    assert.equal(act(mover, code, { cardId: "not-a-card", type: "play" }).ok, false);
    assert.equal(act(mover, code, { type: "nonsense" }).ok, false);
    assert.equal(act(mover, code, { type: "backToLobby" }).ok, false);

    resetRooms();
  }

  // --- the bank is always open, and everyone sees the pile and the moves ------------
  {
    const { clients, code, host } = newTable(["Amina", "Paul"], 0);
    const guest = clients[1];
    const c = (rank: Rank, suit: Suit): Card => ({
      id: `${rank}-${suit}`,
      rank,
      suit,
    });

    assert.ok(act(host, code, { type: "start" }).ok);

    const room = peekRoom(code);

    assert.ok(room);

    // The host holds a playable 9 of hearts, and the bank is on its last card.
    const staged: GameState = {
      bank: [c("3", "clubs")],
      checked: [],
      current: 0, // the host, first in the player list below
      demand: null,
      events: [{ type: "start" }],
      finished: [],
      mode: "first",
      over: false,
      pending: 0,
      pile: [
        c("A", "hearts"),
        c("2", "hearts"),
        c("3", "hearts"),
        c("4", "hearts"),
        c("5", "hearts"),
        c("6", "hearts"),
        c("9", "spades"),
      ],
      players: [
        { hand: [c("9", "hearts"), c("2", "spades")], id: host.seatId, name: "Amina" },
        { hand: [c("K", "hearts")], id: guest.seatId, name: "Paul" },
      ],
      stalled: 0,
      winner: null,
    };

    room.game = staged;

    assert.equal(act(guest, code, { type: "draw" }).ok, false, "not Paul's turn yet");
    assert.equal(act(host, code, { type: "check" }).ok, false, "two cards: no check yet");

    // Take from the bank while holding a playable card: allowed.
    assert.ok(act(host, code, { type: "draw" }).ok, "drawing with a playable card works");

    const hostGame = host.view?.game;
    const guestGame = guest.view?.game;

    assert.ok(hostGame && guestGame);
    assert.equal(hostGame.hand.length, 3, "host took the last bank card");

    // The bank was finished, so the pile was mixed in as the new bank.
    assert.equal(hostGame.bankCount, 6);
    assert.equal(guestGame.bankCount, 6);
    assert.deepEqual(
      guestGame.pile.map((card) => card.id),
      ["9-spades"],
      "only the centre card is left on the table",
    );
    assert.equal(guestGame.centre.id, "9-spades");

    // Both see a draw followed by a reshuffle, in order, with growing numbers.
    const lastTwo = guestGame.moves.slice(-2);

    assert.equal(lastTwo[0].type, "draw");
    assert.equal(lastTwo[1].type, "reshuffle");
    assert.ok(lastTwo[1].seq === lastTwo[0].seq + 1);
    assert.deepEqual(
      lastTwo.map((move) => ("count" in move ? move.count : null)),
      [null, 6],
    );

    // What the host drew is private: only the host's own view names the card.
    const drawn = hostGame.hand[hostGame.hand.length - 1].id;
    const guestJson = JSON.stringify(guest.view);

    assert.ok(!guestJson.includes(`"${drawn}"`), "the drawn card stays private");
    assert.ok(!("card" in lastTwo[0]), "to the others, a draw move carries no card");

    const ownDraw = hostGame.moves.filter((move) => move.type === "draw").pop();

    assert.ok(ownDraw && ownDraw.type === "draw" && ownDraw.card?.id === drawn, "the taker sees the card");
    assert.equal(ownDraw.type === "draw" && ownDraw.forced, false);

    // The turn passed to Paul, who may now draw; the host may not.
    assert.equal(guestGame.canDraw, true);
    assert.equal(hostGame.canDraw, false);

    // Paul has no match (K of hearts on the 9 of spades) and takes a card too.
    assert.ok(act(guest, code, { type: "draw" }).ok);

    // Now a play: the host plays the 9 of hearts on whatever is in the centre.
    const centre = host.view?.game?.centre;

    assert.ok(centre);

    const playable = host.view?.game?.hand.find((card) =>
      host.view?.game?.playableIds.includes(card.id),
    );

    assert.ok(playable, "host has a card that fits");
    assert.equal(host.view?.game?.centre.id, centre.id);
    assert.ok(
      act(host, code, {
        cardId: playable.id,
        suit: playable.rank === "J" ? "hearts" : undefined,
        type: "play",
      }).ok,
    );

    const afterPlay = guest.view?.game;
    const playMove = afterPlay?.moves[afterPlay.moves.length - 1];

    assert.ok(afterPlay && playMove);
    assert.equal(playMove.type, "play");
    assert.equal("card" in playMove ? playMove.card?.id : null, playable.id);
    assert.equal(playMove.type === "play" ? playMove.placement : null, "top");
    assert.equal(afterPlay.pile[afterPlay.pile.length - 1].id, playable.id);
    assert.equal(afterPlay.centre.id, playable.id);
    assert.ok(afterPlay.pile.length <= 8, "only the top of the pile is sent");

    resetRooms();
  }

  // --- special cards through the room: what each player sees ----------------------------
  const s = (rank: Rank, suit: Suit): StandardCard => ({ id: `${rank}-${suit}`, rank, suit });
  const jokerCard = (colour: "red" | "black"): JokerCard => ({
    id: `joker-${colour}`,
    rank: "joker",
    suit: colour,
  });

  /** Put a hand-built game into a started room. Hands are listed host first. */
  function stage(
    code: string,
    clients: Client[],
    hands: Card[][],
    extra: Partial<GameState> = {},
  ) {
    const room = peekRoom(code);

    assert.ok(room);
    room.game = {
      bank: [s("3", "clubs"), s("4", "clubs"), s("5", "clubs"), s("6", "clubs"), s("8", "clubs"), s("9", "clubs")],
      checked: [],
      current: 0,
      demand: null,
      events: [{ type: "start" }],
      finished: [],
      mode: "first",
      over: false,
      pending: 0,
      pile: [s("9", "spades")],
      players: hands.map((hand, i) => ({
        hand,
        id: clients[i].seatId,
        name: room.seats.find((x) => x.id === clients[i].seatId)?.name ?? "?",
      })),
      stalled: 0,
      winner: null,
      ...extra,
    };
    room.phase = "playing";

    return room;
  }

  {
    // ace: the next player is stopped, everyone is shown it
    const { clients, code, host } = newTable(["Amina", "Paul", "Rita"], 0);

    assert.ok(act(host, code, { type: "start" }).ok);
    stage(code, clients, [[s("A", "spades"), s("3", "hearts")], [s("4", "hearts")], [s("5", "hearts")]]);
    assert.ok(act(host, code, { cardId: "A-spades", type: "play" }).ok);

    const view = clients[2].view?.game;

    assert.ok(view);
    assert.equal(view.currentSeatId, clients[2].seatId, "Paul is stopped, Rita plays");
    assert.ok(
      view.moves.some((m) => m.type === "skip" && m.seatId === clients[1].seatId),
      "a skip move names the stopped player",
    );
    assert.ok(view.log.some((line) => /Paul is stopped/.test(line)));
    resetRooms();
  }

  {
    // 7: the next player owes 2, may answer with a 7 or a joker, or takes them (privately)
    const { clients, code, host } = newTable(["Amina", "Paul", "Rita"], 0);
    const [amina, paul, rita] = clients;

    assert.ok(act(host, code, { type: "start" }).ok);
    stage(code, clients, [
      [s("7", "spades"), s("3", "hearts")],
      [s("7", "hearts"), s("5", "diamonds"), s("4", "diamonds")],
      [s("K", "hearts"), s("Q", "hearts")],
    ]);
    assert.ok(act(amina, code, { cardId: "7-spades", type: "play" }).ok);

    assert.equal(paul.view?.game?.pending, 2);
    assert.equal(rita.view?.game?.pending, 2, "everybody sees what is owed");
    assert.deepEqual(paul.view?.game?.playableIds, ["7-hearts"], "only a 7 or a joker answers");
    assert.deepEqual(rita.view?.game?.playableIds, [], "not Rita's turn");
    assert.equal(paul.view?.game?.canDraw, true);

    // a normal card is refused, with the reason
    const wrong = act(paul, code, { cardId: "5-diamonds", type: "play" });

    assert.ok(!wrong.ok && /7 or a joker/.test(wrong.error));

    // taking the penalty: 2 private cards, flagged as forced
    assert.ok(act(paul, code, { type: "draw" }).ok);

    const mine = paul.view?.game;
    const theirs = rita.view?.game;

    assert.ok(mine && theirs);
    assert.equal(mine.hand.length, 3 + 2);
    assert.equal(mine.pending, 0);

    const myDraws = mine.moves.filter((m) => m.type === "draw");
    const theirDraws = theirs.moves.filter((m) => m.type === "draw");

    assert.equal(myDraws.length, 2);
    assert.ok(myDraws.every((m) => m.type === "draw" && m.forced && m.card));
    assert.ok(theirDraws.every((m) => m.type === "draw" && m.forced && !("card" in m)));
    assert.ok(mine.moves.some((m) => m.type === "penalty" && m.count === 2));
    assert.ok(theirs.log.some((line) => /Paul had to take 2 cards/.test(line)));
    assert.ok(!theirs.log.some((line) => /took a card from the bank/.test(line)), "forced draws are not logged one by one");

    for (const taken of ["9-clubs", "8-clubs"]) {
      assert.ok(!JSON.stringify(rita.view).includes(`"${taken}"`), "Rita never learns the cards Paul took");
    }
    resetRooms();
  }

  {
    // joker: 4 cards, a joker answers a 7 of any sign, and the colour rule shows in playableIds
    const { clients, code, host } = newTable(["Amina", "Paul"], 0);
    const [amina, paul] = clients;

    assert.ok(act(host, code, { type: "start" }).ok);
    stage(code, clients, [
      [jokerCard("black"), s("3", "hearts")],
      [jokerCard("red"), s("5", "diamonds")],
    ]);
    assert.ok(act(amina, code, { cardId: "joker-black", type: "play" }).ok);
    assert.equal(paul.view?.game?.pending, 4);
    assert.deepEqual(paul.view?.game?.playableIds, ["joker-red"], "the red joker may answer a black one under attack");
    assert.ok(act(paul, code, { cardId: "joker-red", type: "play" }).ok);
    assert.equal(amina.view?.game?.pending, 8);
    resetRooms();
  }

  {
    // jack: any card, then a sign is asked for
    const { clients, code, host } = newTable(["Amina", "Paul", "Rita"], 0);
    const [amina, paul, rita] = clients;

    assert.ok(act(host, code, { type: "start" }).ok);
    stage(code, clients, [
      [s("J", "hearts"), s("3", "clubs")],
      [s("5", "spades"), s("5", "diamonds"), s("2", "clubs"), s("J", "clubs")],
      [s("8", "diamonds"), s("8", "clubs")],
    ]);

    const noSign = act(amina, code, { cardId: "J-hearts", type: "play" });

    assert.ok(!noSign.ok && /sign/i.test(noSign.error));
    assert.equal(act(amina, code, { cardId: "J-hearts", suit: "stars", type: "play" }).ok, false);
    assert.ok(act(amina, code, { cardId: "J-hearts", suit: "diamonds", type: "play" }).ok);

    assert.equal(paul.view?.game?.demand, "diamonds");
    assert.equal(rita.view?.game?.demand, "diamonds", "everybody sees the asked-for sign");
    assert.deepEqual(paul.view?.game?.playableIds, ["5-diamonds", "2-clubs", "J-clubs"]);
    assert.equal(amina.view?.game?.centre.id, "J-hearts");
    assert.ok(amina.view?.game?.log.some((line) => /asks for diamonds/.test(line)));

    const move = paul.view?.game?.moves.filter((m) => m.type === "play").pop();

    assert.ok(move && move.type === "play" && move.demand === "diamonds");

    assert.ok(act(paul, code, { cardId: "5-diamonds", type: "play" }).ok);
    assert.equal(rita.view?.game?.demand, null, "playing the sign lifts the request");
    resetRooms();
  }

  {
    // 2 under: the centre card stays
    const { clients, code, host } = newTable(["Amina", "Paul"], 0);
    const [amina, paul] = clients;

    assert.ok(act(host, code, { type: "start" }).ok);
    stage(code, clients, [[s("2", "hearts"), s("K", "hearts")], [s("5", "spades"), s("4", "hearts")]]);
    assert.ok(act(amina, code, { cardId: "2-hearts", placement: "under", type: "play" }).ok);

    const view = paul.view?.game;

    assert.ok(view);
    assert.equal(view.centre.id, "9-spades");
    assert.deepEqual(view.pile.map((card) => card.id), ["2-hearts", "9-spades"], "the 2 is hidden under the centre card");

    const move = view.moves.filter((m) => m.type === "play").pop();

    assert.ok(move && move.type === "play" && move.placement === "under");
    assert.ok(view.log.some((line) => /slipped the two of hearts under/.test(line)));
    assert.deepEqual(view.playableIds, ["5-spades"], "Paul still plays on the 9 of spades");
    resetRooms();
  }

  {
    // ranking: the others carry on after the first one games
    const { clients, code, host } = newTable(["Amina", "Paul", "Rita"], 0);
    const [amina, paul, rita] = clients;

    assert.ok(act(host, code, { endMode: "ranking", type: "setSettings" }).ok);
    assert.ok(act(host, code, { type: "start" }).ok);
    stage(
      code,
      clients,
      [[s("9", "hearts")], [s("K", "hearts"), s("Q", "hearts")], [s("5", "hearts"), s("6", "hearts"), s("8", "hearts")]],
      { mode: "ranking" },
    );
    assert.ok(act(amina, code, { cardId: "9-hearts", type: "play" }).ok);

    assert.equal(peekRoom(code)?.phase, "playing", "the set goes on");
    assert.equal(paul.view?.seats.find((x) => x.id === amina.seatId)?.rank, 1);
    assert.equal(paul.view?.game?.over, false);
    assert.equal(paul.view?.game?.currentSeatId, paul.seatId);
    assert.ok(paul.view?.game?.log.some((line) => /Amina says GAMES! \(1st\)/.test(line)));

    assert.ok(act(paul, code, { cardId: "K-hearts", type: "play" }).ok);
    assert.equal(rita.view?.game?.currentSeatId, rita.seatId);
    assert.ok(act(rita, code, { cardId: "5-hearts", type: "play" }).ok);
    assert.equal(paul.view?.game?.currentSeatId, paul.seatId, "Amina is out, so back to Paul");
    assert.ok(act(paul, code, { cardId: "Q-hearts", type: "play" }).ok);

    const done = rita.view;

    assert.equal(done?.phase, "finished");
    assert.deepEqual(
      done?.game?.standings.map((x) => x.name),
      ["Amina", "Paul", "Rita"],
    );
    assert.equal(act(rita, code, { type: "play", cardId: "6-hearts" }).ok, false, "the set is over");
    resetRooms();
  }

  // --- sets with elimination, the final, and coming back ------------------------------------
  for (let round = 0; round < 3; round++) {
    const { clients, code, host } = newTable(["Amina", "Paul"], 2);

    assert.ok(
      act(host, code, { cardsPerPlayer: 3, elimination: false, endMode: "ranking", type: "setSettings" }).ok,
    );
    assert.ok(act(host, code, { elimination: true, type: "setSettings" }).ok);
    assert.ok(act(host, code, { type: "start" }).ok);
    assert.equal(host.view?.tournament.set, 1);

    const everyone = host.view?.seats.map((x) => x.id) ?? [];

    assert.equal(everyone.length, 4);

    const gone: string[] = [];

    // 4 players -> eliminate one -> 3 -> eliminate one -> 2: the final
    for (let set = 1; set <= 3; set++) {
      await playOut(code, clients);

      const room = peekRoom(code);
      const view: RoomView | null = host.view;

      assert.ok(room && view?.game);
      assert.equal(view.phase, "finished");
      assert.equal(view.tournament.set, set);
      assert.equal(view.game.standings.length, 5 - set, "everybody in this set is ranked");

      if (set < 3) {
        // the last one is out for the next set
        const last: string = view.game.standings[view.game.standings.length - 1].seatId;

        gone.push(last);
        assert.deepEqual(view.tournament.eliminatedIds, gone);
        assert.equal(view.tournament.championId, null);
        assert.equal(view.tournament.nextSetAvailable, true);
        assert.equal(view.tournament.finalSet, false);
        assert.equal(view.seats.find((x) => x.id === last)?.eliminated, true);

        // only the host moves on
        assert.equal(act(clients[1], code, { type: "nextSet" }).ok, false);
        assert.ok(act(host, code, { type: "nextSet" }).ok);

        const next: RoomView | null = host.view;

        assert.equal(next?.phase, "playing");
        assert.equal(next?.tournament.set, set + 1);
        assert.equal(next?.tournament.finalSet, set + 1 === 3);

        const out: SeatView | undefined = next?.seats.find((x) => x.id === last);

        assert.equal(out?.inGame, false, "the loser is not dealt in");
        assert.equal(out?.handCount, 0);
        assert.equal(next?.seats.filter((x) => x.inGame).length, 4 - set);

        // an eliminated human watches: no hand, no playable cards, no bank
        const watcher = clients.find((c) => c.seatId === last);

        if (watcher) {
          assert.deepEqual(watcher.view?.game?.hand, []);
          assert.deepEqual(watcher.view?.game?.playableIds, []);
          assert.equal(watcher.view?.game?.canDraw, false);
          assert.equal(watcher.view?.game?.canCheck, false);
          assert.equal(
            act(watcher, code, { type: "draw" }).ok,
            false,
            "a watcher cannot take from the bank",
          );
        }
      } else {
        // the final: two players, one champion
        assert.equal(view.tournament.finalSet, true);
        assert.equal(view.tournament.championId, view.game.standings[0].seatId);
        assert.equal(view.tournament.nextSetAvailable, false);
        assert.equal(act(host, code, { type: "nextSet" }).ok, false, "the tournament is over");
      }
    }

    // after the final everybody is back for a fresh tournament
    assert.equal(act(clients[1], code, { type: "playAgain" }).ok, false, "host only");
    assert.ok(act(host, code, { type: "playAgain" }).ok);
    assert.equal(host.view?.tournament.set, 1);
    assert.deepEqual(host.view?.tournament.eliminatedIds, []);
    assert.equal(host.view?.tournament.championId, null);
    assert.equal(host.view?.seats.filter((x) => x.inGame).length, 4, "the eliminated are back");
    assert.equal(host.view?.phase, "playing");

    resetRooms();
  }

  // --- elimination off: the same table just plays another full set ------------------------------
  {
    const { clients, code, host } = newTable(["Amina"], 2);

    assert.ok(act(host, code, { endMode: "ranking", type: "setSettings" }).ok);
    assert.ok(act(host, code, { type: "start" }).ok);
    await playOut(code, clients);
    assert.deepEqual(host.view?.tournament.eliminatedIds, []);
    assert.equal(host.view?.tournament.nextSetAvailable, true);
    assert.ok(act(host, code, { type: "nextSet" }).ok);
    assert.equal(host.view?.seats.filter((x) => x.inGame).length, 3, "nobody is dropped");
    assert.equal(act(host, code, { type: "nextSet" }).ok, false, "not while a set is on");
    resetRooms();
  }

  // --- a watcher who leaves just goes; the set carries on ----------------------------------------
  {
    const { clients, code, host } = newTable(["Amina", "Paul"], 2);

    assert.ok(act(host, code, { cardsPerPlayer: 3, endMode: "ranking", type: "setSettings" }).ok);
    assert.ok(act(host, code, { elimination: true, type: "setSettings" }).ok);
    assert.ok(act(host, code, { type: "start" }).ok);
    await playOut(code, clients);
    assert.ok(act(host, code, { type: "nextSet" }).ok);

    const eliminated = host.view?.tournament.eliminatedIds[0];
    const watcher = clients.find((c) => c.seatId === eliminated);

    const observer = clients.find((c) => c !== watcher);

    if (watcher && observer) {
      assert.ok(act(watcher, code, { type: "leave" }).ok);
      assert.equal(observer.view?.seats.some((x) => x.id === eliminated), false, "the watcher's seat is gone");
      assert.equal(observer.view?.phase, "playing");
      assert.equal(observer.view?.game?.over, false);
      assert.equal(observer.view?.tournament.eliminatedIds.includes(eliminated ?? ""), false);
      assert.ok(observer.view?.hostId, "someone is still host");
    }
    resetRooms();
  }

  console.log("All room-server checks passed.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
