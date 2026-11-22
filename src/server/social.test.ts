import assert from "node:assert/strict";
import {
  applyAction,
  configureRooms,
  type Identity,
  joinInto,
  nextWakeAt,
  newMatchRoom,
  newRoom,
  type Room,
  setPresence,
  tickBots,
  viewFor,
} from "./rooms";
import { cleanText, CHAT_GAP_MS, newSocial, postChat, tally, winningOption } from "./social";

/**
 * Chat, stickers, ready-ups, votes, the automatic return to the lobby and the
 * win counter. These work on plain rooms (no store, no network), with the clock
 * passed in so nothing has to wait.
 */
configureRooms({ botDelayMax: 2, botDelayMin: 0, returnDelay: 25_000, voteDuration: 30_000 });

const T0 = Date.now();

type Who = { id: string; token: string; name: string };

function table(names: string[], bots = 0) {
  const created = newRoom("TEST", names[0], T0);
  const room: Room = created.room;
  const people: Who[] = [{ id: created.seatId, name: names[0], token: created.token }];

  for (const name of names.slice(1)) {
    const joined = joinInto(room, name, undefined, T0);

    assert.ok(joined.ok);

    if (joined.ok) {
      people.push({ id: joined.seatId, name, token: joined.token });
    }
  }

  for (let i = 0; i < bots; i++) {
    assert.ok(applyAction(room, people[0].id, people[0].token, { type: "addBot" }, T0).ok);
  }

  return { people, room };
}

/** Everybody at the table has their page open right now (browsers ask every second or so). */
function here(room: Room, now: number) {
  for (const seat of room.seats) {
    if (seat.kind === "human") {
      seat.polledAt = now;
    }
  }
}

const act = (room: Room, who: Who, action: object, now: number) =>
  applyAction(room, who.id, who.token, action, now);
const view = (room: Room, who: Who, now: number) => viewFor(room, who.id, now);

/** Humans play the simplest legal move; bots move when ticked. Returns the clock. */
function playOut(room: Room, people: Who[], from: number) {
  let now = from;

  for (let step = 0; step < 6000 && room.phase === "playing"; step++) {
    now += 5;
    tickBots(room, now);

    const mover = people.find((p) => room.game && room.game.players[room.game.current].id === p.id);

    if (!mover || room.phase !== "playing") {
      continue;
    }

    const game = view(room, mover, now).game;

    assert.ok(game);

    const playable = game.hand.find((card) => game.playableIds.includes(card.id));
    const result = act(
      room,
      mover,
      playable
        ? { cardId: playable.id, suit: playable.rank === "J" ? "hearts" : undefined, type: "play" }
        : { type: "draw" },
      now,
    );

    assert.ok(result.ok, JSON.stringify(result));
  }

  assert.equal(room.phase, "finished", "the game finished");

  return now;
}

// --- text and rate limits ---------------------------------------------------------
{
  assert.equal(cleanText("  hello \n\n  there\u0007  "), "hello there");
  assert.equal(cleanText("x".repeat(500)).length, 140);
  assert.equal(cleanText(undefined), "");
  assert.equal(Array.from(cleanText("😀".repeat(200))).length, 140, "cut by character, not by byte");

  const social = newSocial();

  assert.ok(postChat(social, "a", "Amina", "hi", 1000).ok);
  assert.equal(postChat(social, "a", "Amina", "again", 1000 + CHAT_GAP_MS - 1).ok, false, "too fast");
  assert.ok(postChat(social, "a", "Amina", "again", 1000 + CHAT_GAP_MS).ok);
  assert.ok(postChat(social, "b", "Paul", "me too", 1001).ok, "limits are per player");
  assert.equal(postChat(social, "a", "Amina", "   ", 5000).ok, false, "empty");
  assert.ok(postChat(social, "a", "Amina", "clock went back", 10).ok, "a clock that jumps back never blocks");

  for (let i = 0; i < 80; i++) {
    postChat(social, `u${i}`, "x", `m${i}`, 100000 + i);
  }

  assert.ok(social.chat.length <= 50, "the chat never grows without limit");
  assert.ok(social.chat[social.chat.length - 1].id > 50, "ids keep counting");
}

// --- chat and stickers through the room ---------------------------------------------
{
  const { people, room } = table(["Amina", "Paul"]);
  const [amina, paul] = people;

  // joining is announced by the table
  assert.ok(view(room, amina, T0 + 1).chat.some((m) => m.seatId === null && /Paul joined/.test(m.text)));

  assert.ok(act(room, amina, { text: "  Hello   Paul ", type: "chat" }, T0 + 1000).ok);

  const seen = view(room, paul, T0 + 1001).chat;
  const last = seen[seen.length - 1];

  assert.equal(last.text, "Hello Paul");
  assert.equal(last.seatId, amina.id);
  assert.equal(last.name, "Amina");

  const tooFast = act(room, amina, { text: "again", type: "chat" }, T0 + 1100);

  assert.ok(!tooFast.ok && /Slow down/.test(tooFast.error));
  assert.equal(act(room, amina, { text: "", type: "chat" }, T0 + 5000).ok, false);
  assert.equal(act(room, { ...amina, token: "bad" }, { text: "x", type: "chat" }, T0 + 5000).ok, false);

  // views carry at most the latest 30 lines
  for (let i = 0; i < 45; i++) {
    assert.ok(act(room, i % 2 ? amina : paul, { text: `line ${i}`, type: "chat" }, T0 + 10_000 + i * 1000).ok);
  }

  assert.equal(view(room, amina, T0 + 60_000).chat.length, 30);
  assert.equal(view(room, amina, T0 + 60_000).chat.at(-1)?.text, "line 44");

  // stickers
  const version = view(room, amina, T0 + 60_000).version;

  assert.ok(act(room, paul, { emoji: "🔥", type: "react" }, T0 + 70_000).ok);
  assert.equal(act(room, paul, { emoji: "💩", type: "react" }, T0 + 80_000).ok, false, "only the stickers on the list");
  assert.equal(act(room, paul, { emoji: "😂", type: "react" }, T0 + 70_100).ok, false, "not twice in a blink");

  const after = view(room, amina, T0 + 70_200);

  assert.ok(after.version > version, "a sticker is a change browsers can see");
  assert.deepEqual(
    after.reactions.map((r) => [r.seatId, r.emoji]),
    [[paul.id, "🔥"]],
  );
  assert.equal(after.reactions[0].seq, 1);

  assert.ok(act(room, paul, { emoji: "GG!", type: "react" }, T0 + 71_000).ok);
  assert.deepEqual(
    view(room, amina, T0 + 71_100).reactions.map((r) => r.seq),
    [1, 2],
  );
}

// --- ready, host, auto-return switch ----------------------------------------------------
{
  const { people, room } = table(["Amina", "Paul", "Rita"], 1);
  const [amina, paul, rita] = people;

  const ready = (who: Who, now: number) =>
    view(room, amina, now).seats.find((s) => s.id === who.id)?.ready;

  assert.equal(ready(paul, T0 + 10), false);
  assert.ok(act(room, paul, { ready: true, type: "ready" }, T0 + 20).ok);
  assert.equal(ready(paul, T0 + 30), true);
  assert.equal(view(room, amina, T0 + 30).seats.find((s) => s.kind === "bot")?.ready, true, "bots are always ready");
  assert.ok(act(room, paul, { ready: false, type: "ready" }, T0 + 40).ok);
  assert.equal(ready(paul, T0 + 50), false);

  // only the host hands the host over, and only to a human
  assert.equal(act(room, paul, { seatId: rita.id, type: "makeHost" }, T0 + 60).ok, false);
  assert.equal(act(room, amina, { seatId: amina.id, type: "makeHost" }, T0 + 60).ok, false);
  assert.equal(
    act(room, amina, { seatId: view(room, amina, T0).seats.find((s) => s.kind === "bot")?.id, type: "makeHost" }, T0 + 60).ok,
    false,
  );
  assert.ok(act(room, amina, { seatId: rita.id, type: "makeHost" }, T0 + 60).ok);
  assert.equal(view(room, amina, T0 + 70).hostId, rita.id);
  assert.equal(act(room, amina, { type: "start" }, T0 + 80).ok, false, "the old host cannot start any more");

  assert.equal(view(room, amina, T0 + 70).autoReturn, true);
  assert.equal(act(room, amina, { type: "setAutoReturn", value: false }, T0 + 80).ok, false);
  assert.ok(act(room, rita, { type: "setAutoReturn", value: false }, T0 + 80).ok);
  assert.equal(view(room, amina, T0 + 90).autoReturn, false);
  assert.equal(act(room, rita, { type: "setAutoReturn", value: "yes" }, T0 + 90).ok, false);

  // ready is cleared when a game starts
  assert.ok(act(room, paul, { ready: true, type: "ready" }, T0 + 100).ok);
  assert.ok(act(room, rita, { type: "start" }, T0 + 110).ok);
  assert.equal(act(room, paul, { ready: true, type: "ready" }, T0 + 120).ok, false, "ready is for the lobby");
  assert.equal(view(room, amina, T0 + 130).seats.find((s) => s.id === paul.id)?.ready, false);
}

// --- votes: the rules ----------------------------------------------------------------------
{
  const { people, room } = table(["Amina", "Paul", "Rita"]);
  const [amina, paul, rita] = people;
  const t = T0 + 1000;

  assert.equal(act(room, amina, { kind: "rules", topic: "nonsense", type: "startVote" }, t).ok, false);
  assert.equal(act(room, amina, { kind: "weird", type: "startVote" }, t).ok, false);
  assert.equal(act(room, amina, { kind: "rematch", type: "startVote" }, t).ok, false, "no rematch before a game");
  assert.equal(act(room, amina, { type: "castVote", choice: "on" }, t).ok, false, "nothing to vote on yet");

  assert.ok(act(room, paul, { kind: "rules", topic: "jokers", type: "startVote" }, t).ok, "any player may start one");
  assert.equal(act(room, amina, { kind: "rules", topic: "cards", type: "startVote" }, t).ok, false, "one vote at a time");

  const opened = view(room, rita, t + 1).vote;

  assert.ok(opened);
  assert.equal(opened.kind, "rules");
  assert.equal(opened.byId, paul.id);
  assert.equal(opened.voters, 3);
  assert.equal(opened.voted, 0);
  assert.deepEqual(opened.options.map((o) => o.id), ["on", "off"]);
  assert.equal(opened.canCancel, false);
  assert.equal(view(room, paul, t + 1).vote?.canCancel, true, "who started it can call it off");
  assert.equal(view(room, amina, t + 1).vote?.canCancel, true, "so can the host");
  assert.ok(view(room, rita, t + 1).vote?.endsInMs && view(room, rita, t + 1).vote!.endsInMs > 29_000);

  assert.equal(act(room, amina, { type: "castVote", choice: "maybe" }, t + 2).ok, false, "not a choice");
  assert.ok(act(room, amina, { type: "castVote", choice: "off" }, t + 3).ok);
  assert.ok(act(room, amina, { type: "castVote", choice: "on" }, t + 4).ok, "you can change your mind");
  assert.ok(act(room, amina, { type: "castVote", choice: "off" }, t + 5).ok);
  assert.equal(view(room, rita, t + 6).vote?.voted, 1);
  assert.equal(view(room, rita, t + 6).vote?.yourChoice, null);
  assert.equal(view(room, amina, t + 6).vote?.yourChoice, "off");
  assert.deepEqual(view(room, rita, t + 6).vote?.options.map((o) => o.count), [0, 1]);
  assert.ok(act(room, paul, { type: "castVote", choice: "off" }, t + 7).ok);
  assert.equal(view(room, rita, t + 8).settings.jokers, true, "not over: Rita has not voted");
  assert.ok(act(room, rita, { type: "castVote", choice: "on" }, t + 9).ok);

  // everybody voted: 2 against 1, so it is decided at once
  const decided = view(room, rita, t + 10);

  assert.equal(decided.vote, null);
  assert.equal(decided.settings.jokers, false, "the vote changed the rules");
  assert.ok(decided.chat.some((m) => m.seatId === null && /Vote passed: No jokers/.test(m.text)));

  // a rest between votes
  const soon = act(room, paul, { kind: "rules", topic: "ending", type: "startVote" }, t + 3000);

  assert.ok(!soon.ok && /Wait a moment/.test(soon.error));

  // a three-way split changes nothing
  const t2 = t + 20_000;

  here(room, t2);

  assert.ok(act(room, amina, { kind: "rules", topic: "cards", type: "startVote" }, t2).ok);

  const options = view(room, amina, t2).vote?.options.map((o) => o.id) ?? [];

  assert.ok(options.length >= 3);

  const cardsBefore = view(room, amina, t2).settings.cardsPerPlayer;

  for (const [index, who] of [amina, paul, rita].entries()) {
    assert.ok(act(room, who, { choice: options[index], type: "castVote" }, t2 + 10 + index).ok);
  }

  assert.equal(view(room, amina, t2 + 20).settings.cardsPerPlayer, cardsBefore);
  assert.ok(view(room, amina, t2 + 20).chat.at(-1)?.text.includes("no result"));

  // time runs out: counted by whoever asks next, even though Rita never voted
  const t3 = t2 + 20_000;

  here(room, t3);

  assert.ok(act(room, amina, { kind: "rules", topic: "ending", type: "startVote" }, t3).ok);
  assert.ok(act(room, amina, { choice: "ranking", type: "castVote" }, t3 + 1).ok);
  assert.ok(nextWakeAt(room) === t3 + 30_000, "the realtime server knows when to wake up");
  assert.equal(tickBots(room, t3 + 10_000), false, "still running");
  assert.equal(view(room, amina, t3 + 10_000).vote?.voted, 1);
  assert.equal(tickBots(room, t3 + 30_001), true, "time is up");
  assert.equal(view(room, amina, t3 + 30_002).vote, null);
  assert.equal(view(room, amina, t3 + 30_002).settings.endMode, "ranking");

  // a vote called off changes nothing and does not make anybody wait
  const t4 = t3 + 60_000;

  here(room, t4);

  assert.ok(act(room, amina, { kind: "rules", topic: "jokers", type: "startVote" }, t4).ok);
  assert.equal(act(room, rita, { type: "cancelVote" }, t4 + 1).ok, false, "only who started it, or the host");
  assert.ok(act(room, amina, { type: "cancelVote" }, t4 + 2).ok);
  assert.equal(view(room, amina, t4 + 3).vote, null);
  assert.ok(act(room, paul, { kind: "rules", topic: "jokers", type: "startVote" }, t4 + 4).ok);
}

// --- votes: removing a player, and who counts ------------------------------------------------
{
  const { people, room } = table(["Amina", "Paul", "Rita"]);
  const [amina, paul, rita] = people;
  const t = T0 + 1000;

  const two = table(["Amina", "Paul"]);

  assert.equal(
    act(two.room, two.people[0], { kind: "kick", seatId: two.people[1].id, type: "startVote" }, t).ok,
    false,
    "with two players there is nobody to outvote",
  );
  assert.equal(act(room, paul, { kind: "kick", seatId: amina.id, type: "startVote" }, t).ok, false, "the host cannot be voted out");
  assert.equal(act(room, paul, { kind: "kick", seatId: paul.id, type: "startVote" }, t).ok, false, "nor yourself");

  // Rita is the target: only Amina and Paul vote, and they need to agree
  assert.ok(act(room, paul, { kind: "kick", seatId: rita.id, type: "startVote" }, t).ok);
  assert.equal(view(room, rita, t + 1).vote?.canVote, false);
  assert.equal(view(room, amina, t + 1).vote?.voters, 2);
  assert.equal(act(room, rita, { choice: "no", type: "castVote" }, t + 2).ok, false, "the one in question has no say");
  assert.ok(act(room, amina, { choice: "yes", type: "castVote" }, t + 3).ok);
  assert.ok(act(room, paul, { choice: "no", type: "castVote" }, t + 4).ok);
  assert.equal(room.seats.length, 3, "one yes out of two is not a majority");
  assert.ok(view(room, amina, t + 5).chat.at(-1)?.text.includes("Vote failed"));

  // a later vote works, once the rest is over
  const later = t + 20_000;

  here(room, later);

  assert.ok(act(room, paul, { kind: "kick", seatId: rita.id, type: "startVote" }, later).ok);
  assert.ok(act(room, amina, { choice: "yes", type: "castVote" }, later + 1).ok);
  assert.ok(act(room, paul, { choice: "yes", type: "castVote" }, later + 2).ok);
  assert.deepEqual(room.seats.map((s) => s.name), ["Amina", "Paul"], "Rita was voted out");
  assert.ok(view(room, amina, later + 3).chat.at(-1)?.text.includes("Rita was removed by vote"));
  assert.equal(act(room, rita, { type: "chat", text: "hello?" }, later + 4).ok, false, "her token is dead");
}
{
  // someone who is not there does not hold the vote up: the others decide as soon as they have voted
  const { people, room } = table(["Amina", "Paul", "Rita"]);
  const [amina, paul, rita] = people;
  const t = T0 + 20_000;

  // Amina and Paul are here (they asked recently), Rita closed her page long ago
  for (const who of [amina, paul]) {
    room.seats.find((s) => s.id === who.id)!.polledAt = t;
  }

  room.seats.find((s) => s.id === rita.id)!.polledAt = t - 1000; // she was here a second ago
  assert.equal(setPresence(room, rita.id, false, t), true, "the realtime server marks her offline");
  assert.equal(setPresence(room, rita.id, false, t), false, "nothing changed the second time");
  assert.equal(view(room, amina, t).seats.find((s) => s.id === rita.id)?.connected, false);

  assert.ok(act(room, amina, { kind: "rules", topic: "jokers", type: "startVote" }, t).ok);
  assert.ok(act(room, amina, { choice: "off", type: "castVote" }, t + 1).ok);
  assert.equal(view(room, amina, t + 2).vote?.voted, 1);
  assert.ok(act(room, paul, { choice: "off", type: "castVote" }, t + 3).ok);
  assert.equal(view(room, amina, t + 4).vote, null, "decided without Rita");
  assert.equal(view(room, amina, t + 4).settings.jokers, false);

  assert.equal(setPresence(room, rita.id, true, t + 5), true);
  assert.equal(view(room, amina, t + 6).seats.find((s) => s.id === rita.id)?.connected, true);
}

// --- tally helpers ------------------------------------------------------------------------------
{
  const vote = {
    ballots: { a: "yes", b: "yes", c: "no", gone: "yes" },
    by: "a",
    endsAt: 0,
    id: 1,
    kind: "kick" as const,
    options: [
      { id: "yes", label: "Yes", patch: null },
      { id: "no", label: "No", patch: null },
    ],
    targetId: null,
    title: "?",
  };

  assert.deepEqual(tally(vote, ["a", "b", "c"]).counts, { no: 1, yes: 2 }, "only people who may vote are counted");
  assert.equal(winningOption(vote, ["a", "b", "c"]), "yes");
  assert.equal(winningOption(vote, ["a", "b", "c", "d"]), null, "yes must be MORE than half of all voters");
  assert.equal(winningOption({ ...vote, ballots: {} }, ["a"]), null);
}

// --- the game ends: wins, rematch vote, back to the lobby by itself --------------------------------
{
  const { people, room } = table(["Amina", "Paul"], 1);
  const [amina, paul] = people;

  assert.ok(act(room, amina, { cardsPerPlayer: 3, type: "setSettings" }, T0).ok);
  assert.ok(act(room, amina, { type: "start" }, T0 + 1).ok);
  assert.ok(act(room, paul, { ready: true, type: "ready" }, T0 + 2).ok === false);

  let now = playOut(room, [amina, paul], T0 + 10);

  assert.equal(room.phase, "finished");

  const results = view(room, amina, now);
  const winnerId = results.game?.winnerId ?? "";

  assert.equal(results.seats.find((s) => s.id === winnerId)?.wins, 1, "the win is counted");
  assert.equal(results.seats.filter((s) => s.wins > 0).length, 1);
  assert.ok(results.returnInMs !== null && results.returnInMs > 24_000 && results.returnInMs <= 25_000);
  assert.ok(nextWakeAt(room) !== null);

  // not yet
  assert.equal(tickBots(room, now + 20_000), false);
  assert.equal(room.phase, "finished");

  // a vote holds the lobby back; a rematch vote starts another game
  here(room, now + 21_000);
  assert.ok(act(room, paul, { kind: "rematch", type: "startVote" }, now + 21_000).ok);
  assert.equal(view(room, amina, now + 21_001).returnInMs, null, "no countdown during a vote");
  assert.equal(tickBots(room, now + 26_000), false, "and nothing happens at the old time");
  assert.equal(room.phase, "finished");
  here(room, now + 26_001);
  assert.ok(act(room, amina, { choice: "yes", type: "castVote" }, now + 26_001).ok);
  assert.ok(act(room, paul, { choice: "yes", type: "castVote" }, now + 26_002).ok);
  assert.equal(room.phase, "playing", "the rematch started");
  assert.equal(room.gameCount, 2);
  assert.equal(view(room, amina, now + 26_003).seats.filter((s) => s.wins > 0).length, 1, "the wins carry over");

  now = playOut(room, [amina, paul], now + 26_010);

  assert.equal(
    view(room, amina, now).seats.reduce((sum, s) => sum + s.wins, 0),
    2,
    "two games, two wins",
  );

  // nobody does anything: after the delay the table is back in the lobby, everybody still seated
  const finishedView = view(room, amina, now);

  assert.ok(finishedView.returnInMs !== null);
  assert.equal(tickBots(room, now + 25_001), true);
  assert.equal(room.phase, "lobby");
  assert.equal(room.game, null);
  assert.equal(room.seats.length, 3);

  const lobby = view(room, paul, now + 25_002);

  assert.equal(lobby.phase, "lobby");
  assert.equal(lobby.game, null);
  assert.equal(lobby.returnInMs, null);
  assert.ok(lobby.chat.at(-1)?.text.includes("Back in the lobby"));
  assert.equal(lobby.seats.find((s) => s.id === paul.id)?.ready, false);
  assert.equal(tickBots(room, now + 99_000), false, "and it stays there");
  assert.ok(act(room, amina, { type: "start" }, now + 99_001).ok, "the host can start again");
}
{
  // the switch is off: the results stay until the host moves on
  const { people, room } = table(["Amina"], 1);
  const [amina] = people;

  assert.ok(act(room, amina, { type: "setAutoReturn", value: false }, T0).ok);
  assert.ok(act(room, amina, { cardsPerPlayer: 3, type: "setSettings" }, T0).ok);
  assert.ok(act(room, amina, { type: "start" }, T0 + 1).ok);

  const now = playOut(room, [amina], T0 + 10);

  assert.equal(view(room, amina, now).returnInMs, null);
  assert.equal(tickBots(room, now + 600_000), false);
  assert.equal(room.phase, "finished");
}
{
  // in the middle of an elimination tournament nobody is sent back
  const { people, room } = table(["Amina"], 2);
  const [amina] = people;

  assert.ok(act(room, amina, { cardsPerPlayer: 3, endMode: "ranking", type: "setSettings" }, T0).ok);
  assert.ok(act(room, amina, { elimination: true, type: "setSettings" }, T0 + 1).ok);
  assert.ok(act(room, amina, { type: "start" }, T0 + 2).ok);

  const now = playOut(room, [amina], T0 + 10);

  assert.equal(view(room, amina, now).tournament.nextSetAvailable, true);
  assert.equal(view(room, amina, now).returnInMs, null, "the next set is coming, not the lobby");
  assert.equal(tickBots(room, now + 600_000), false);
  assert.equal(room.phase, "finished");
}

// --- bots move at the time they are due (the realtime server sets its timer from this) ---------------
{
  const { people, room } = table(["Amina"], 1);
  const [amina] = people;

  assert.ok(act(room, amina, { type: "start" }, T0).ok);
  assert.equal(nextWakeAt(room) !== null || room.game?.players[room.game.current].id === amina.id, true);
}

// --- rooms made before this version still work -------------------------------------------------------
{
  const { people, room } = table(["Amina", "Paul"]);
  const [amina, paul] = people;
  const old = JSON.parse(JSON.stringify(room)) as Partial<Room>;

  delete old.social;

  const loaded = old as Room;
  const seen = viewFor(loaded, amina.id, T0 + 5);

  assert.deepEqual(seen.chat, []);
  assert.equal(seen.autoReturn, true);
  assert.equal(seen.vote, null);
  assert.equal(seen.reactions.length, 0);
  assert.equal(loaded.social, undefined, "reading a view never changes the room");
  assert.ok(act(loaded, paul, { text: "I am still here", type: "chat" }, T0 + 2000).ok);
  assert.equal(viewFor(loaded, amina.id, T0 + 2001).chat.at(-1)?.text, "I am still here");
  assert.ok(act(loaded, amina, { kind: "rules", topic: "jokers", type: "startVote" }, T0 + 3000).ok);
}

// --- a room is plain data ------------------------------------------------------------------------------
{
  const { people, room } = table(["Amina", "Paul", "Rita"], 1);
  const [amina, paul] = people;

  act(room, amina, { text: "hi", type: "chat" }, T0 + 1000);
  act(room, paul, { emoji: "😎", type: "react" }, T0 + 1000);
  act(room, paul, { ready: true, type: "ready" }, T0 + 1000);
  act(room, amina, { kind: "rules", topic: "cards", type: "startVote" }, T0 + 1000);

  const copy = JSON.parse(JSON.stringify(room)) as Room;

  assert.deepEqual(copy, room, "a room is made only of plain data");
  assert.deepEqual(viewFor(copy, amina.id, T0 + 2000), viewFor(room, amina.id, T0 + 2000));
}

// --- the turn clock ---------------------------------------------------------------------------------
{
  const { people, room } = table(["Amina", "Paul"]);
  const [amina, paul] = people;

  assert.equal(view(room, amina, T0).turnSeconds, 0, "no clock by default");
  assert.equal(act(room, paul, { seconds: 10, type: "setTimer" }, T0).ok, false, "host only");

  for (const bad of [2, 121, -5, 4.2e9, "10", null]) {
    assert.equal(act(room, amina, { seconds: bad, type: "setTimer" }, T0).ok, bad === 4.2e9 ? false : false, `refused: ${String(bad)}`);
  }

  assert.ok(act(room, amina, { seconds: 10, type: "setTimer" }, T0).ok);
  assert.equal(view(room, paul, T0).turnSeconds, 10);
  assert.ok(act(room, amina, { seconds: 0, type: "setTimer" }, T0).ok, "0 switches it off");
  assert.ok(act(room, amina, { seconds: 7, type: "setTimer" }, T0).ok, "any value from 3 to 120");
  assert.ok(act(room, amina, { type: "start" }, T0).ok);
  assert.equal(act(room, amina, { seconds: 10, type: "setTimer" }, T0).ok, false, "not during a game");

  const game = room.game!;
  const slow = people.find((p) => p.id === game.players[game.current].id)!;
  const quick = people.find((p) => p !== slow)!;
  const ends = room.social.turnEndsAt!;

  assert.ok(ends > Date.now() + 7000, "the first turn has a few seconds of grace");
  assert.ok(view(room, quick, T0).turnEndsInMs! > 7000);
  assert.equal(nextWakeAt(room), ends, "the realtime server wakes up when the clock runs out");
  assert.equal(tickBots(room, ends - 1), false);

  const before = room.game!.players.find((p) => p.id === slow.id)!.hand.length;

  assert.equal(tickBots(room, ends + 1), true, "time is up");
  assert.equal(room.game!.players.find((p) => p.id === slow.id)!.hand.length, before + 1, "they take a card");
  assert.equal(room.game!.players[room.game!.current].id, quick.id, "and the turn passes");
  assert.equal(room.social.turnEndsAt, ends + 1 + 7000, "the next player gets a full clock");
  assert.ok(view(room, quick, ends + 2).game!.moves.some((m) => m.type === "timeout" && m.seatId === slow.id));
  assert.ok(view(room, quick, ends + 2).game!.log.some((line) => /ran out of time/.test(line)));
  assert.equal(room.social.timeouts[slow.id], 1);

  // acting in time resets nothing for the next one but clears the count
  const game2 = view(room, quick, ends + 3).game!;
  const move = game2.hand.find((c) => game2.playableIds.includes(c.id));

  assert.ok(act(room, quick, move ? { cardId: move.id, suit: move.rank === "J" ? "hearts" : undefined, type: "play" } : { type: "draw" }, ends + 4).ok);
  assert.equal(room.social.timeouts[quick.id] ?? 0, 0);
}
{
  // three clocks in a row: the table plays for the player until they are back
  const { people, room } = table(["Amina"], 1);
  const [amina] = people;

  assert.ok(act(room, amina, { seconds: 5, type: "setTimer" }, T0).ok);
  assert.ok(act(room, amina, { type: "start" }, T0).ok);

  let now = T0;

  for (let i = 0; i < 60 && room.social.away[amina.id] !== true && room.phase === "playing"; i++) {
    now = Math.max(room.social.turnEndsAt ?? 0, room.botDueAt ?? 0, now) + 1;
    tickBots(room, now);
  }

  assert.equal(room.social.away[amina.id], true, "marked away after three");
  assert.equal(view(room, amina, now).seats.find((s) => s.id === amina.id)?.away, true);
  assert.ok(view(room, amina, now).chat.some((m) => /is away/.test(m.text)));

  // from now on the clock is short and the table plays a card for them
  for (let i = 0; i < 6 && room.phase === "playing"; i++) {
    const game = room.game!;

    if (game.players[game.current].id === amina.id) {
      assert.equal(room.social.turnEndsAt! - now <= 1500 + 2000, true);
    }

    now = Math.max(room.social.turnEndsAt ?? 0, room.botDueAt ?? 0, now) + 1;
    tickBots(room, now);
  }

  assert.ok(act(room, amina, { type: "back" }, now + 10).ok);
  assert.equal(view(room, amina, now + 11).seats.find((s) => s.id === amina.id)?.away, false);
  assert.equal(room.social.timeouts[amina.id], 0);
}

// --- the host removes players during a game ---------------------------------------------------------------
{
  const { people, room } = table(["Amina", "Paul", "Rita"], 1);
  const [amina, paul, rita] = people;

  assert.equal(act(room, amina, { seatId: paul.id, type: "kickPlayer" }, T0).ok, false, "not before the game");
  assert.ok(act(room, amina, { type: "start" }, T0).ok);
  assert.equal(act(room, paul, { seatId: rita.id, type: "kickPlayer" }, T0).ok, false, "host only");
  assert.equal(act(room, amina, { seatId: amina.id, type: "kickPlayer" }, T0).ok, false, "not yourself");
  assert.equal(act(room, amina, { seatId: "nobody", type: "kickPlayer" }, T0).ok, false);

  const cards = (r: Room) =>
    r.game!.bank.length + r.game!.pile.length + r.game!.players.reduce((n, p) => n + p.hand.length, 0);
  const total = cards(room);

  assert.ok(act(room, amina, { seatId: paul.id, type: "kickPlayer" }, T0 + 10).ok);
  assert.equal(room.seats.some((s) => s.id === paul.id), false, "Paul is gone");
  assert.equal(room.game!.players.some((p) => p.id === paul.id), false);
  assert.equal(cards(room), total, "his cards went back to the bank");
  assert.ok(view(room, amina, T0 + 11).chat.some((m) => /Paul was removed by the host/.test(m.text)));
  assert.equal(act(room, paul, { text: "hi", type: "chat" }, T0 + 20).ok, false, "his seat is dead");
  assert.equal(room.phase, "playing");

  // a bot can be removed too; then only two are left and the game goes on
  const bot = room.seats.find((s) => s.kind === "bot")!;

  assert.ok(act(room, amina, { seatId: bot.id, type: "kickPlayer" }, T0 + 30).ok);
  assert.equal(room.game!.players.length, 2);
  assert.equal(room.phase, "playing");

  // remove the last opponent: the host wins
  assert.ok(act(room, amina, { seatId: rita.id, type: "kickPlayer" }, T0 + 40).ok);
  assert.equal(room.phase, "finished");
  assert.equal(room.game!.winner, amina.id);
  assert.equal(view(room, amina, T0 + 41).seats.find((s) => s.id === amina.id)?.wins, 1);
}

// --- after a game nobody walks out ----------------------------------------------------------------------------
{
  const { people, room } = table(["Amina", "Paul"], 1);
  const [amina, paul] = people;

  assert.ok(act(room, amina, { cardsPerPlayer: 3, type: "setSettings" }, T0).ok);
  assert.ok(act(room, amina, { type: "start" }, T0 + 1).ok);

  const now = playOut(room, [amina, paul], T0 + 10);

  here(room, now);
  assert.equal(view(room, paul, now).canLeave, false, "the button is gone");
  assert.equal(view(room, amina, now).canLeave, true, "the host decides, so the host may go");

  const stuck = act(room, paul, { type: "leave" }, now + 1);

  assert.ok(!stuck.ok && /Play again or go back to the lobby/.test(stuck.error));
  assert.equal(room.seats.some((s) => s.id === paul.id), true, "still at the table");

  // the host is gone: nobody is held
  room.seats.find((s) => s.id === amina.id)!.polledAt = 0;
  assert.equal(view(room, paul, now + 20_000).canLeave, true);
  assert.ok(act(room, paul, { type: "leave" }, now + 20_000).ok);
}
{
  // in the lobby and in the middle of a game leaving is always allowed
  const { people, room } = table(["Amina", "Paul", "Rita"]);
  const [amina, paul, rita] = people;

  assert.equal(view(room, paul, T0).canLeave, true);
  assert.ok(act(room, rita, { type: "leave" }, T0).ok);
  assert.ok(act(room, amina, { type: "start" }, T0 + 1).ok);
  assert.equal(view(room, paul, T0 + 2).canLeave, true);
  assert.ok(act(room, paul, { type: "leave" }, T0 + 3).ok);
}

// --- the host writes a vote ---------------------------------------------------------------------------------------
{
  const { people, room } = table(["Amina", "Paul", "Rita"]);
  const [amina, paul, rita] = people;
  const t = T0 + 1000;

  here(room, t);
  assert.equal(act(room, paul, { kind: "custom", options: ["a", "b"], question: "Pizza?", type: "startVote" }, t).ok, false, "host only");

  for (const bad of [
    { options: ["only one"], question: "Pizza or what?" },
    { options: ["same", "SAME"], question: "Pizza or what?" },
    { options: ["a", "b"], question: "  " },
    { options: ["a", "b", "c", "d", "e", "f", "g"], question: "Too many?" },
    { options: "a,b", question: "Not a list?" },
  ]) {
    assert.equal(act(room, amina, { kind: "custom", type: "startVote", ...bad }, t).ok, false, JSON.stringify(bad));
  }

  assert.ok(
    act(room, amina, { kind: "custom", options: ["Pizza", "Rice", "Plantain"], question: "What do we eat after?", type: "startVote" }, t).ok,
  );

  const open = view(room, paul, t + 1).vote!;

  assert.equal(open.title, "What do we eat after?");
  assert.deepEqual(open.options.map((o) => o.label), ["Pizza", "Rice", "Plantain"]);
  assert.equal(open.kind, "custom");
  assert.equal(open.voters, 3, "everybody votes, the host too");

  const settings = JSON.stringify(view(room, paul, t).settings);

  assert.ok(act(room, amina, { choice: "o1", type: "castVote" }, t + 2).ok);
  assert.ok(act(room, paul, { choice: "o1", type: "castVote" }, t + 3).ok);
  assert.ok(act(room, rita, { choice: "o0", type: "castVote" }, t + 4).ok);

  const done = view(room, paul, t + 5);

  assert.equal(done.vote, null);
  assert.ok(done.chat.at(-1)?.text.includes("Vote result: What do we eat after? → Rice (2 of 3)"), done.chat.at(-1)?.text ?? "");
  assert.equal(JSON.stringify(done.settings), settings, "nothing happens by itself");

  // a tie is announced as a tie
  here(room, t + 20_000);
  assert.ok(act(room, amina, { kind: "custom", options: ["Yes", "No"], question: "Another round?", type: "startVote" }, t + 20_000).ok);
  assert.ok(act(room, amina, { choice: "o0", type: "castVote" }, t + 20_001).ok);
  assert.ok(act(room, paul, { choice: "o1", type: "castVote" }, t + 20_002).ok);
  assert.ok(act(room, rita, { choice: "o1", type: "castVote" }, t + 20_003).ok);
  assert.ok(view(room, paul, t + 20_004).chat.at(-1)?.text.includes("Vote result: Another round? → No (2 of 3)"));

  // nobody votes: said so
  here(room, t + 60_000);
  assert.ok(act(room, amina, { kind: "custom", options: ["Yes", "No"], question: "Anybody there?", type: "startVote" }, t + 60_000).ok);
  assert.equal(tickBots(room, t + 91_000), true);
  assert.ok(view(room, paul, t + 91_001).chat.at(-1)?.text.includes("Nobody voted"));
}

// --- profiles at the table: identity, rejoin and results -------------------------------------------------------------
{
  const id = (n: number): Identity => ({ avatar: "🦁", profileId: `profile-${n}-aaaa`, rating: 1000 + n, xp: n * 10 });
  const created = newRoom("PROF", "Amina", T0, id(1));
  const room = created.room;

  assert.equal(room.seats[0].profileId, "profile-1-aaaa");
  assert.equal(viewFor(room, created.seatId, T0).seats[0].avatar, "🦁");
  assert.equal(viewFor(room, created.seatId, T0).seats[0].xp, 10);

  const joined = joinInto(room, "Paul", undefined, T0, id(2));

  assert.ok(joined.ok);

  const amina = { id: created.seatId, name: "Amina", token: created.token };
  const paul = joined.ok ? { id: joined.seatId, name: "Paul", token: joined.token } : amina;

  // the same device coming back without its saved token gets its own seat (also in the lobby)
  const again = joinInto(room, "Whatever", undefined, T0 + 5, id(2));

  assert.ok(again.ok && again.seatId === paul.id && again.token === paul.token);
  assert.equal(room.seats.length, 2, "no second seat");

  // a guest (no profile) still works
  const guest = joinInto(room, "Guest", undefined, T0 + 6);

  assert.ok(guest.ok);
  assert.equal(room.seats[2].profileId, null);
  assert.ok(act(room, amina, { seatId: room.seats[2].id, type: "removeSeat" }, T0 + 7).ok);

  assert.ok(act(room, amina, { cardsPerPlayer: 3, type: "setSettings" }, T0 + 8).ok);
  assert.ok(act(room, amina, { type: "addBot" }, T0 + 8).ok);
  assert.ok(act(room, amina, { type: "start" }, T0 + 9).ok);

  // ...and coming back in the middle of a game gives the seat back too
  const mid = joinInto(room, "Whatever", undefined, T0 + 10, id(2));

  assert.ok(mid.ok && mid.seatId === paul.id);
  assert.equal(joinInto(room, "Stranger", undefined, T0 + 10, id(9)).ok, false, "a new player cannot join a game on");

  const now = playOut(room, [amina, paul], T0 + 20);
  const result = room.social.results!;

  assert.ok(result, "the set left a result for the profiles");
  assert.equal(result.id, "PROF-1");
  assert.equal(result.mode, "friends", "two real people");
  assert.equal(result.humans, 2);
  assert.equal(result.size, 3);
  assert.deepEqual(result.players.map((p) => p.profileId).sort(), ["profile-1-aaaa", "profile-2-aaaa"]);
  assert.equal(result.players.filter((p) => p.won).length, room.game!.winner === amina.id || room.game!.winner === paul.id ? 1 : 0);
  assert.ok(result.players.every((p) => p.tally.played >= 0 && !p.left));
  assert.ok(result.players.reduce((sum, p) => sum + p.tally.played + p.tally.drawn, 0) > 0, "the cards they played and took were counted");
  assert.ok(now > 0);

  // a new set is a new result
  assert.ok(act(room, amina, { type: "playAgain" }, now + 1).ok);
  assert.equal(room.social.results, null);
}
{
  // quitting in the middle of a set is remembered
  const id = (n: number): Identity => ({ avatar: "🦊", profileId: `quitter-${n}-bbbb`, rating: 1000, xp: 0 });
  const created = newRoom("QUIT", "Amina", T0, id(1));
  const room = created.room;
  const joined = joinInto(room, "Paul", undefined, T0, id(2));

  assert.ok(joined.ok);

  const amina = { id: created.seatId, name: "Amina", token: created.token };
  const paul = joined.ok ? { id: joined.seatId, name: "Paul", token: joined.token } : amina;

  assert.ok(act(room, amina, { type: "addBot" }, T0).ok);
  assert.ok(act(room, amina, { cardsPerPlayer: 3, type: "setSettings" }, T0).ok);
  assert.ok(act(room, amina, { type: "start" }, T0 + 1).ok);
  assert.ok(act(room, paul, { type: "leave" }, T0 + 2).ok);
  assert.equal(room.seats.find((s) => s.id === paul.id)?.profileId, null, "the bot that took the seat has no profile");

  playOut(room, [amina], T0 + 10);

  const result = room.social.results!;
  const left = result.players.find((p) => p.profileId === "quitter-2-bbbb")!;

  assert.ok(left.left && !left.won, "Paul quit");
  assert.equal(result.players.find((p) => p.profileId === "quitter-1-bbbb")?.left, false);
  assert.equal(result.humans, 2, "he counts as a person who was there");
}

// --- a quick match ---------------------------------------------------------------------------------------------------------------
{
  const entry = (n: number, name: string) => ({
    identity: { avatar: "🎯", profileId: `match-${n}-cccc`, rating: 1000, xp: 0 } as Identity,
    name,
    ticketId: `ticket-${n}`,
  });
  const { creds, room } = newMatchRoom("MTCH", [entry(1, "Amina"), entry(2, "Paul"), entry(3, "Rita")], { bots: 1, cardsPerPlayer: 4, turnSeconds: 15 }, T0);

  assert.equal(room.phase, "playing", "the game is already on");
  assert.equal(room.seats.length, 4);
  assert.equal(room.game!.players.length, 4);
  assert.deepEqual(Object.keys(creds).sort(), ["ticket-1", "ticket-2", "ticket-3"]);

  const who = (ticket: string): Who => ({ id: creds[ticket].seatId, name: ticket, token: creds[ticket].token });
  const [amina, paul, rita] = [who("ticket-1"), who("ticket-2"), who("ticket-3")];
  const seen = view(room, amina, T0 + 1);

  assert.equal(seen.matchmade, true);
  assert.equal(seen.turnSeconds, 15);
  assert.equal(seen.settings.cardsPerPlayer, 4);
  assert.equal(seen.hostId, amina.id);
  assert.ok(seen.chat.some((m) => /Quick match/.test(m.text)));
  assert.equal(seen.seats.find((s) => s.id === amina.id)?.avatar, "🎯");
  assert.equal(seen.seats.find((s) => s.kind === "bot")?.avatar, "🤖");

  // the table is set up: nobody (not even the host) can change it
  for (const action of [
    { type: "addBot" },
    { cardsPerPlayer: 2, type: "setSettings" },
    { seatId: paul.id, type: "kickPlayer" },
    { seatId: paul.id, type: "makeHost" },
    { seconds: 5, type: "setTimer" },
    { kind: "rules", topic: "jokers", type: "startVote" },
    { kind: "custom", options: ["a", "b"], question: "Hello there", type: "startVote" },
  ]) {
    const result = act(room, amina, action, T0 + 2);

    assert.ok(!result.ok && /quick match/.test(result.error), JSON.stringify(action));
  }

  // but chat and stickers work, and the game is played normally
  assert.ok(act(room, paul, { text: "hello", type: "chat" }, T0 + 1000).ok);

  const now = playOut(room, [amina, paul, rita], T0 + 2000);
  const result = room.social.results!;

  assert.equal(result.mode, "online");
  assert.equal(result.humans, 3);
  assert.equal(result.size, 4);
  assert.equal(view(room, amina, now).returnInMs, null, "no lobby after a quick match");
  assert.equal(tickBots(room, now + 600_000), false);
  assert.equal(room.phase, "finished");

  // strangers are not held: everybody may leave, or ask for a rematch
  assert.equal(view(room, rita, now).canLeave, true);
  assert.ok(act(room, rita, { kind: "rematch", type: "startVote" }, now + 1).ok);
  here(room, now + 2);
  assert.ok(act(room, amina, { choice: "yes", type: "castVote" }, now + 2).ok);
  assert.ok(act(room, paul, { choice: "yes", type: "castVote" }, now + 3).ok);
  assert.ok(act(room, rita, { choice: "yes", type: "castVote" }, now + 4).ok);
  assert.equal(room.phase, "playing", "the rematch started");
  assert.equal(room.social.matchmade, true);
  assert.equal(room.social.turnSeconds, 15, "the clock stays");
  assert.ok(act(room, paul, { type: "leave" }, now + 5).ok);
}

// --- doubling: switched on by the host or by a vote ------------------------------------------------------------------
{
  const { people, room } = table(["Amina", "Paul", "Rita"]);
  const [amina, paul, rita] = people;
  const t = T0 + 1000;

  assert.equal(view(room, paul, t).doubling, false, "off by default");
  assert.equal(act(room, paul, { type: "setDoubling", value: true }, t).ok, false, "host only");
  assert.equal(act(room, amina, { type: "setDoubling", value: "yes" }, t).ok, false);
  assert.ok(act(room, amina, { type: "setDoubling", value: true }, t).ok);
  assert.equal(view(room, paul, t).doubling, true);
  assert.ok(act(room, amina, { type: "setDoubling", value: false }, t).ok);

  // or the table votes for it
  here(room, t + 1000);
  assert.ok(act(room, paul, { kind: "rules", topic: "doubling", type: "startVote" }, t + 1000).ok);
  assert.deepEqual(view(room, amina, t + 1001).vote?.options.map((o) => o.id), ["on", "off"]);
  assert.ok(act(room, amina, { choice: "on", type: "castVote" }, t + 1002).ok);
  assert.ok(act(room, paul, { choice: "on", type: "castVote" }, t + 1003).ok);
  assert.ok(act(room, rita, { choice: "off", type: "castVote" }, t + 1004).ok);
  assert.equal(view(room, amina, t + 1005).doubling, true, "2 against 1: doubling is on");
  assert.ok(view(room, amina, t + 1005).chat.at(-1)?.text.includes("Doubling on"));

  // the game is dealt with doubling on, and a stack can be played through the room
  assert.ok(act(room, amina, { type: "start" }, t + 2000).ok);
  assert.equal(room.game!.doubling, true);

  const game = room.game!;
  const mover = people.find((p) => p.id === game.players[game.current].id)!;
  const hand = game.players[game.current].hand;

  game.pile = [{ id: "9-spades", rank: "9", suit: "spades" }];
  game.pending = 0;
  game.demand = null;
  hand.splice(0, hand.length, { id: "4-hearts", rank: "4", suit: "hearts" }, { id: "4-spades", rank: "4", suit: "spades" }, { id: "K-hearts", rank: "K", suit: "hearts" });

  const wrong = act(room, mover, { cardId: "4-hearts", cardIds: ["4-hearts", "4-spades"], type: "play" }, t + 2100);

  assert.ok(!wrong.ok && /bottom card must match/.test(wrong.error));
  assert.ok(act(room, mover, { cardId: "4-spades", cardIds: ["4-spades", "4-hearts"], type: "play" }, t + 2200).ok);

  const after = view(room, mover, t + 2300).game!;

  assert.deepEqual(after.pile.map((c) => c.id), ["9-spades", "4-spades", "4-hearts"]);
  assert.equal(after.centre.id, "4-hearts");
  assert.deepEqual(after.hand.map((c) => c.id), ["K-hearts"]);
  assert.equal(after.moves.filter((m) => m.type === "play").length, 2);

  // when it is off, a stack is refused
  const off = table(["Amina", "Paul"]);

  assert.ok(act(off.room, off.people[0], { type: "start" }, T0).ok);

  const g2 = off.room.game!;
  const m2 = off.people.find((p) => p.id === g2.players[g2.current].id)!;

  g2.pile = [{ id: "9-spades", rank: "9", suit: "spades" }];
  g2.players[g2.current].hand.splice(0, 9, { id: "4-hearts", rank: "4", suit: "hearts" }, { id: "4-spades", rank: "4", suit: "spades" });

  const no = act(off.room, m2, { cardId: "4-spades", cardIds: ["4-spades", "4-hearts"], type: "play" }, T0 + 5);

  assert.ok(!no.ok && /not allowed at this table/.test(no.error));

  // a quick match never has it
  assert.equal(act(room, amina, { type: "setDoubling", value: true }, t + 9000).ok, false, "not during a game");
}

console.log("All social checks passed.");
