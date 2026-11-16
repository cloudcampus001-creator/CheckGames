import assert from "node:assert/strict";
import {
  applyAction,
  configureRooms,
  joinInto,
  nextWakeAt,
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

console.log("All social checks passed.");
