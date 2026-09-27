/*
 * 2048 rules engine — pure game logic, no DOM.
 *
 * Implements the standard rules of 2048 (design Gabriele Cirulli) on square
 * boards of 3×3, 4×4, 5×5 and 6×6:
 *  - The board starts with two tiles; each spawned tile is a 2 (90%) or a 4 (10%).
 *  - A move slides every tile as far as it can go in the chosen direction.
 *  - Two tiles of equal value that collide merge into one tile of twice the
 *    value, scoring that value. A tile produced by a merge cannot merge again
 *    during the same move, and the tile nearest the wall merges first.
 *  - A move is legal only if it changes the board; after a legal move one new
 *    tile spawns in a random empty cell.
 *  - Reaching the target tile wins; the player may keep playing afterwards.
 *  - The game is over when the board is full and no orthogonal neighbours match.
 *
 * Tiles carry identities so a front end can animate them from their previous
 * position; `mergedFrom` holds the two tiles that produced a merged tile.
 *
 * Loads as `Game2048Engine` in the browser or via require() in Node.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Game2048Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZES = [3, 4, 5, 6];
  const DEFAULT_TARGETS = { 3: 256, 4: 2048, 5: 4096, 6: 8192 };
  const START_TILES = 2;
  const FOUR_CHANCE = 0.1;

  const UP = 'up';
  const RIGHT = 'right';
  const DOWN = 'down';
  const LEFT = 'left';
  const DIRECTIONS = [UP, RIGHT, DOWN, LEFT];

  const VECTORS = {
    [UP]: { row: -1, col: 0 },
    [RIGHT]: { row: 0, col: 1 },
    [DOWN]: { row: 1, col: 0 },
    [LEFT]: { row: 0, col: -1 },
  };

  /*
   * Deterministic counter-based RNG (splitmix32). The stream position lives in
   * the state as `rngCalls`, so cloning a state — for undo or for an AI search —
   * reproduces exactly the same future draws.
   */
  function randomFrom(seed, calls) {
    let t = (((seed >>> 0) + Math.imul(calls + 1, 0x9e3779b9)) >>> 0);
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  }

  function random(state) {
    const value = randomFrom(state.seed, state.rngCalls);
    state.rngCalls += 1;
    return value;
  }

  function makeTile(id, row, col, value) {
    return {
      id,
      row,
      col,
      value,
      prevRow: row,
      prevCol: col,
      isNew: true,
      mergedFrom: null,
    };
  }

  const cellIndex = (state, row, col) => row * state.size + col;
  const withinBounds = (state, row, col) =>
    row >= 0 && row < state.size && col >= 0 && col < state.size;
  const tileAt = (state, row, col) =>
    withinBounds(state, row, col) ? state.cells[cellIndex(state, row, col)] : null;

  function setTile(state, row, col, tile) {
    state.cells[cellIndex(state, row, col)] = tile;
    if (tile) {
      tile.row = row;
      tile.col = col;
    }
  }

  function emptyCells(state) {
    const free = [];
    for (let row = 0; row < state.size; row += 1) {
      for (let col = 0; col < state.size; col += 1) {
        if (!tileAt(state, row, col)) free.push({ row, col });
      }
    }
    return free;
  }

  function tiles(state) {
    return state.cells.filter(Boolean);
  }

  function spawnTile(state) {
    const free = emptyCells(state);
    if (!free.length) return null;
    const spot = free[Math.floor(random(state) * free.length)];
    const value = random(state) < FOUR_CHANCE ? 4 : 2;
    state.nextTileId += 1;
    const tile = makeTile(state.nextTileId, spot.row, spot.col, value);
    setTile(state, spot.row, spot.col, tile);
    return tile;
  }

  /* Clear the per-move animation bookkeeping and remember where each tile was. */
  function prepareTiles(state) {
    for (const tile of tiles(state)) {
      tile.prevRow = tile.row;
      tile.prevCol = tile.col;
      tile.isNew = false;
      tile.mergedFrom = null;
    }
  }

  function newGame(options) {
    const opts = options || {};
    const size = opts.size || 4;
    if (SIZES.indexOf(size) === -1) throw new Error('unsupported board size: ' + size);
    const seed = opts.seed === undefined ? (Math.random() * 0xffffffff) >>> 0 : opts.seed >>> 0;
    const state = {
      size,
      target: opts.target || DEFAULT_TARGETS[size],
      seed,
      rngCalls: 0,
      cells: new Array(size * size).fill(null),
      score: 0,
      best: opts.best || 0,
      moveCount: 0,
      nextTileId: 0,
      won: false,
      keepPlaying: false,
      over: false,
      lastDirection: null,
      lastGain: 0,
      largest: 0,
    };
    for (let i = 0; i < START_TILES; i += 1) spawnTile(state);
    state.largest = largestTile(state);
    return state;
  }

  function clone(state) {
    const copy = Object.assign({}, state);
    copy.cells = new Array(state.size * state.size).fill(null);
    for (const tile of tiles(state)) {
      copy.cells[cellIndex(state, tile.row, tile.col)] = Object.assign({}, tile);
    }
    return copy;
  }

  /* Traversal order: always resolve the cells nearest the target wall first. */
  function traversals(state, direction) {
    const vector = VECTORS[direction];
    const rows = [];
    const cols = [];
    for (let i = 0; i < state.size; i += 1) {
      rows.push(i);
      cols.push(i);
    }
    if (vector.row === 1) rows.reverse();
    if (vector.col === 1) cols.reverse();
    return { rows, cols };
  }

  /* Farthest free cell in `direction`, plus whatever tile blocks the way. */
  function findFarthest(state, row, col, vector) {
    let previousRow = row;
    let previousCol = col;
    let nextRow = row + vector.row;
    let nextCol = col + vector.col;
    while (withinBounds(state, nextRow, nextCol) && !tileAt(state, nextRow, nextCol)) {
      previousRow = nextRow;
      previousCol = nextCol;
      nextRow += vector.row;
      nextCol += vector.col;
    }
    return {
      farthest: { row: previousRow, col: previousCol },
      next: withinBounds(state, nextRow, nextCol) ? { row: nextRow, col: nextCol } : null,
    };
  }

  function canMove(state) {
    if (emptyCells(state).length) return true;
    for (let row = 0; row < state.size; row += 1) {
      for (let col = 0; col < state.size; col += 1) {
        const tile = tileAt(state, row, col);
        if (!tile) continue;
        const right = tileAt(state, row, col + 1);
        const down = tileAt(state, row + 1, col);
        if ((right && right.value === tile.value) || (down && down.value === tile.value)) return true;
      }
    }
    return false;
  }

  function availableMoves(state) {
    return DIRECTIONS.filter((direction) => wouldChange(state, direction));
  }

  /* Does this direction change anything? Checked without mutating the state. */
  function wouldChange(state, direction) {
    const vector = VECTORS[direction];
    for (let row = 0; row < state.size; row += 1) {
      for (let col = 0; col < state.size; col += 1) {
        const tile = tileAt(state, row, col);
        if (!tile) continue;
        const aheadRow = row + vector.row;
        const aheadCol = col + vector.col;
        if (!withinBounds(state, aheadRow, aheadCol)) continue;
        const ahead = tileAt(state, aheadRow, aheadCol);
        if (!ahead || ahead.value === tile.value) return true;
      }
    }
    return false;
  }

  function largestTile(state) {
    let largest = 0;
    for (const tile of tiles(state)) if (tile.value > largest) largest = tile.value;
    return largest;
  }

  /*
   * Apply a move in place. Returns a report describing what happened, or null
   * when the move is illegal (nothing on the board would change).
   */
  function move(state, direction) {
    if (state.over && !state.keepPlaying) return null;
    if (!VECTORS[direction]) throw new Error('unknown direction: ' + direction);
    if (!wouldChange(state, direction)) return null;

    const vector = VECTORS[direction];
    const order = traversals(state, direction);
    prepareTiles(state);

    let gained = 0;
    let merges = 0;
    let reachedTarget = false;

    for (const row of order.rows) {
      for (const col of order.cols) {
        const tile = tileAt(state, row, col);
        if (!tile) continue;
        const positions = findFarthest(state, row, col, vector);
        const blocker = positions.next ? tileAt(state, positions.next.row, positions.next.col) : null;

        if (blocker && blocker.value === tile.value && !blocker.mergedFrom) {
          state.nextTileId += 1;
          const merged = makeTile(state.nextTileId, blocker.row, blocker.col, tile.value * 2);
          merged.isNew = false;
          merged.prevRow = tile.prevRow;
          merged.prevCol = tile.prevCol;
          merged.mergedFrom = [tile, blocker];
          setTile(state, row, col, null);
          setTile(state, merged.row, merged.col, merged);
          tile.row = merged.row;
          tile.col = merged.col;
          gained += merged.value;
          merges += 1;
          if (merged.value >= state.target) reachedTarget = true;
        } else if (positions.farthest.row !== row || positions.farthest.col !== col) {
          setTile(state, row, col, null);
          setTile(state, positions.farthest.row, positions.farthest.col, tile);
        }
      }
    }

    state.score += gained;
    if (state.score > state.best) state.best = state.score;
    state.moveCount += 1;
    state.lastDirection = direction;
    state.lastGain = gained;

    const spawned = spawnTile(state);
    state.largest = largestTile(state);
    if (reachedTarget && !state.won) state.won = true;
    state.over = !canMove(state);

    return {
      direction,
      gained,
      merges,
      spawned,
      won: reachedTarget,
      over: state.over,
      score: state.score,
      largest: state.largest,
    };
  }

  /* Plain values grid, handy for tests and for serialising a position. */
  function valueGrid(state) {
    const grid = [];
    for (let row = 0; row < state.size; row += 1) {
      const line = [];
      for (let col = 0; col < state.size; col += 1) {
        const tile = tileAt(state, row, col);
        line.push(tile ? tile.value : 0);
      }
      grid.push(line);
    }
    return grid;
  }

  /* Build a state directly from a values grid — no spawning, for tests/puzzles. */
  function fromGrid(grid, options) {
    const opts = options || {};
    const size = grid.length;
    const state = {
      size,
      target: opts.target || DEFAULT_TARGETS[size] || 2048,
      seed: opts.seed === undefined ? 1 : opts.seed >>> 0,
      rngCalls: opts.rngCalls || 0,
      cells: new Array(size * size).fill(null),
      score: opts.score || 0,
      best: opts.best || 0,
      moveCount: opts.moveCount || 0,
      nextTileId: 0,
      won: false,
      keepPlaying: !!opts.keepPlaying,
      over: false,
      lastDirection: null,
      lastGain: 0,
      largest: 0,
    };
    for (let row = 0; row < size; row += 1) {
      if (grid[row].length !== size) throw new Error('grid must be square');
      for (let col = 0; col < size; col += 1) {
        const value = grid[row][col];
        if (!value) continue;
        state.nextTileId += 1;
        const tile = makeTile(state.nextTileId, row, col, value);
        tile.isNew = false;
        setTile(state, row, col, tile);
      }
    }
    state.largest = largestTile(state);
    state.over = !canMove(state);
    return state;
  }

  return {
    SIZES, DEFAULT_TARGETS, START_TILES, FOUR_CHANCE,
    UP, RIGHT, DOWN, LEFT, DIRECTIONS, VECTORS,
    randomFrom, newGame, clone, fromGrid,
    tileAt, tiles, emptyCells, spawnTile,
    move, wouldChange, canMove, availableMoves,
    largestTile, valueGrid,
  };
});
