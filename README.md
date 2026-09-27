# 2048 Digital

A self-contained browser implementation of 2048, the sliding tile puzzle by
Gabriele Cirulli, on four board sizes — 3×3, 4×4, 5×5 and 6×6 — with a built-in
expectimax AI that can suggest your next move or play the game itself.

## Classic-rules parity

- One push moves the whole board: every tile slides as far as it can in the
  chosen direction
- Two equal tiles that collide fuse into their double and score that value; a
  tile produced by a merge cannot merge again in the same move, and the pair
  nearest the wall you pushed toward merges first
- A direction is legal only if something actually moves; after each legal move
  exactly one new tile appears in a random empty cell — a 2 nine times out of
  ten, otherwise a 4
- The game begins with two tiles and ends when the grid is full with no two
  orthogonal neighbours matching
- Reaching the target tile wins, and you may keep playing for a higher score

## Board sizes

| Grid | Character | Standard target |
|---|---|---|
| 3×3 | Tight — barely room to sort | 256 |
| 4×4 | Classic | 2048 |
| 5×5 | Roomy | 4096 |
| 6×6 | Marathon | 8192 |

The target is selectable per size, and the best score is remembered separately
for every size-and-target combination.

## AI player

Expectimax over the same rules the engine enforces, in three strengths:

- **Casual** — one-ply greedy with deliberate randomness; beatable
- **Standard** — fixed-depth expectimax over both spawn values
- **Expert** — iterative deepening under a per-move time budget, sampling the
  most awkward spawn cells once the branching factor grows

The board is scored on empty cells, row/column monotonicity, smoothness between
neighbours, available merges, and keeping the largest tile in a corner.

## More features

- **Autoplay** — one button hands the board to the AI at the selected strength;
  it plays on through new games until you stop it, with a speed setting and
  pause/resume. Any arrow key, WASD or swipe takes the board straight back
- **Play one AI move** — a single AI move on demand, without giving up control
- **AI search readout** — the strength, search depth and think time of the
  AI's most recent decision, in the match-control panel
- **Suggest a move** — the expert AI marks the edge you should push toward in
  green
- **Undo** — steps back through your own moves; the spawn stream is part of the
  saved state, so replaying the same direction reproduces the same tile rather
  than rerolling it
- **Match result** — a result screen on a locked board or a completed target,
  with the final score, largest tile, and the option to keep playing
- Arrow keys, WASD, HJKL, or swipe; `u` undoes, `n` starts a new game, `space`
  plays one AI move, `g` hands the board to the AI, and `p` pauses it

## Files

- `engine.js` — pure rules engine (no DOM); loads in the browser or Node
- `ai.js` — AI player built on the engine
- `game.js` — UI wiring
- `index.html`, `styles.css` — front end
- `tests/engine.test.js`, `tests/ai.test.js` — Node test suites

## Run

Open `index.html` in a browser, or serve this directory with any static web server:

```sh
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

## Test

```sh
node tests/engine.test.js   # rules: sliding, merge order, spawning, end conditions
node tests/ai.test.js       # AI: engine parity, legality, time budget, strength
```

The AI suite plays full games on every board size and takes a couple of minutes.
