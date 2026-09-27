/*
 * 2048 AI player — expectimax search over the rules implemented by engine.js.
 *
 * The search runs on plain value grids (arrays of numbers) rather than on the
 * engine's tile objects, so a node costs an array copy instead of an object
 * graph. The slide/merge logic mirrors engine.move exactly: nearest-wall first,
 * a merged tile cannot merge twice in one move.
 *
 * Strengths:
 *   casual   — one-ply greedy with deliberate randomness; beatable
 *   standard — fixed-depth expectimax over the two spawn values
 *   expert   — iterative deepening under a time budget, sampling only the most
 *              probable spawn cells once the branching factor gets large
 *
 * Loads as `Game2048AI` in the browser or via require() in Node.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./engine.js'));
  else root.Game2048AI = factory(root.Game2048Engine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const LEVELS = {
    casual: { depth: 1, budgetMs: 0, randomness: 0.35 },
    standard: { depth: 3, budgetMs: 0, randomness: 0 },
    expert: { depth: 6, budgetMs: 90, randomness: 0 },
  };

  /*
   * Second stop condition for the budgeted search. A clock is not always
   * trustworthy — browsers clamp timer resolution for privacy, and headless
   * runs can freeze it outright — so a deepening pass also stops after this
   * many expanded nodes, whatever Date.now() claims.
   */
  const NODE_LIMIT = 120000;

  const WEIGHTS = {
    empty: 12.0,
    monotonicity: 1.2,
    smoothness: 0.25,
    maxInCorner: 8.0,
    merges: 1.5,
  };

  const SPAWNS = [
    { value: 2, probability: 1 - E.FOUR_CHANCE },
    { value: 4, probability: E.FOUR_CHANCE },
  ];

  /* --- grid helpers: a grid is a flat array of size*size values, 0 = empty --- */

  const at = (grid, size, row, col) => grid[row * size + col];

  function gridFromState(state) {
    const grid = new Array(state.size * state.size).fill(0);
    for (const tile of E.tiles(state)) grid[tile.row * state.size + tile.col] = tile.value;
    return grid;
  }

  /* Pull one line (row or column, in travel order) out of the grid. */
  function readLine(grid, size, direction, index) {
    const line = new Array(size);
    for (let i = 0; i < size; i += 1) {
      if (direction === E.LEFT) line[i] = at(grid, size, index, i);
      else if (direction === E.RIGHT) line[i] = at(grid, size, index, size - 1 - i);
      else if (direction === E.UP) line[i] = at(grid, size, i, index);
      else line[i] = at(grid, size, size - 1 - i, index);
    }
    return line;
  }

  function writeLine(grid, size, direction, index, line) {
    for (let i = 0; i < size; i += 1) {
      if (direction === E.LEFT) grid[index * size + i] = line[i];
      else if (direction === E.RIGHT) grid[index * size + (size - 1 - i)] = line[i];
      else if (direction === E.UP) grid[i * size + index] = line[i];
      else grid[(size - 1 - i) * size + index] = line[i];
    }
  }

  /* Slide a single line toward index 0, merging equal neighbours once each. */
  function collapse(line) {
    const size = line.length;
    const packed = [];
    for (let i = 0; i < size; i += 1) if (line[i]) packed.push(line[i]);
    const result = [];
    let gained = 0;
    for (let i = 0; i < packed.length; i += 1) {
      if (i + 1 < packed.length && packed[i] === packed[i + 1]) {
        const merged = packed[i] * 2;
        result.push(merged);
        gained += merged;
        i += 1;
      } else {
        result.push(packed[i]);
      }
    }
    while (result.length < size) result.push(0);
    return { line: result, gained };
  }

  /* Apply a move to a copy of the grid. Returns null when nothing changes. */
  function slide(grid, size, direction) {
    const next = grid.slice();
    let changed = false;
    let gained = 0;
    for (let index = 0; index < size; index += 1) {
      const before = readLine(grid, size, direction, index);
      const collapsed = collapse(before);
      gained += collapsed.gained;
      for (let i = 0; i < size; i += 1) {
        if (before[i] !== collapsed.line[i]) changed = true;
      }
      writeLine(next, size, direction, index, collapsed.line);
    }
    return changed ? { grid: next, gained } : null;
  }

  /* --- evaluation --- */

  function countEmpty(grid) {
    let empty = 0;
    for (let i = 0; i < grid.length; i += 1) if (!grid[i]) empty += 1;
    return empty;
  }

  /*
   * Monotonicity: reward rows and columns that run consistently up or down, so
   * the big tiles stay banked along one edge instead of scattering.
   */
  function monotonicity(grid, size) {
    let left = 0;
    let right = 0;
    let up = 0;
    let down = 0;
    const rank = (value) => (value ? Math.log2(value) : 0);
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col + 1 < size; col += 1) {
        const current = rank(at(grid, size, row, col));
        const next = rank(at(grid, size, row, col + 1));
        if (current > next) right += next - current;
        else left += current - next;
      }
    }
    for (let col = 0; col < size; col += 1) {
      for (let row = 0; row + 1 < size; row += 1) {
        const current = rank(at(grid, size, row, col));
        const next = rank(at(grid, size, row + 1, col));
        if (current > next) down += next - current;
        else up += current - next;
      }
    }
    return Math.max(left, right) + Math.max(up, down);
  }

  /* Smoothness: penalise large jumps between orthogonal neighbours. */
  function smoothness(grid, size) {
    let penalty = 0;
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const value = at(grid, size, row, col);
        if (!value) continue;
        const rank = Math.log2(value);
        if (col + 1 < size && at(grid, size, row, col + 1)) {
          penalty -= Math.abs(rank - Math.log2(at(grid, size, row, col + 1)));
        }
        if (row + 1 < size && at(grid, size, row + 1, col)) {
          penalty -= Math.abs(rank - Math.log2(at(grid, size, row + 1, col)));
        }
      }
    }
    return penalty;
  }

  function adjacentMerges(grid, size) {
    let merges = 0;
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const value = at(grid, size, row, col);
        if (!value) continue;
        if (col + 1 < size && at(grid, size, row, col + 1) === value) merges += 1;
        if (row + 1 < size && at(grid, size, row + 1, col) === value) merges += 1;
      }
    }
    return merges;
  }

  function evaluate(grid, size) {
    let largest = 0;
    for (let i = 0; i < grid.length; i += 1) if (grid[i] > largest) largest = grid[i];
    const corners = [
      grid[0],
      grid[size - 1],
      grid[grid.length - size],
      grid[grid.length - 1],
    ];
    const cornerBonus = corners.indexOf(largest) === -1 ? 0 : Math.log2(largest || 2);
    return (
      WEIGHTS.empty * countEmpty(grid) +
      WEIGHTS.monotonicity * monotonicity(grid, size) +
      WEIGHTS.smoothness * smoothness(grid, size) +
      WEIGHTS.maxInCorner * cornerBonus +
      WEIGHTS.merges * adjacentMerges(grid, size)
    );
  }

  /* --- expectimax --- */

  /* True once the pass has spent either its time budget or its node budget. */
  function exhausted(context) {
    if (!context.deadline) return false;
    if (context.nodes >= context.nodeLimit) return true;
    return Date.now() > context.deadline;
  }

  function emptyIndices(grid) {
    const free = [];
    for (let i = 0; i < grid.length; i += 1) if (!grid[i]) free.push(i);
    return free;
  }

  function searchMove(grid, size, depth, context) {
    if (exhausted(context)) {
      context.timedOut = true;
      return { score: evaluate(grid, size), direction: null };
    }
    context.nodes += 1;
    let best = -Infinity;
    let bestDirection = null;
    for (const direction of E.DIRECTIONS) {
      const moved = slide(grid, size, direction);
      if (!moved) continue;
      const value =
        depth <= 1
          ? evaluate(moved.grid, size) + moved.gained * 0.1
          : searchSpawn(moved.grid, size, depth - 1, context) + moved.gained * 0.1;
      if (value > best) {
        best = value;
        bestDirection = direction;
      }
    }
    if (bestDirection === null) return { score: -1e9, direction: null };
    return { score: best, direction: bestDirection };
  }

  /*
   * Chance node. With many empty cells the full expectation is far too wide, so
   * sample the cells adjacent to existing tiles — the placements that actually
   * threaten the structure — capped by the level's branching limit.
   */
  function searchSpawn(grid, size, depth, context) {
    const free = emptyIndices(grid);
    if (!free.length) return evaluate(grid, size);

    let cells = free;
    if (free.length > context.maxSpawnCells) {
      const scored = free.map((index) => ({ index, weight: spawnRisk(grid, size, index) }));
      scored.sort((a, b) => b.weight - a.weight);
      cells = scored.slice(0, context.maxSpawnCells).map((entry) => entry.index);
    }

    let total = 0;
    for (const index of cells) {
      for (const spawn of SPAWNS) {
        grid[index] = spawn.value;
        total += spawn.probability * searchMove(grid, size, depth, context).score;
        grid[index] = 0;
      }
      if (exhausted(context)) {
        context.timedOut = true;
        break;
      }
    }
    return total / cells.length;
  }

  /* How awkward a spawn in this cell is: neighbouring occupied cells make it worse. */
  function spawnRisk(grid, size, index) {
    const row = Math.floor(index / size);
    const col = index % size;
    let risk = 0;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || c < 0 || r >= size || c >= size) {
        risk += 0.5;
        continue;
      }
      if (at(grid, size, r, c)) risk += 1;
    }
    return risk;
  }

  /*
   * Choose a direction for the given engine state. Returns
   * { direction, score, depth, nodesMs } or null when no move is legal.
   */
  function chooseMove(state, level, options) {
    const config = LEVELS[level] || LEVELS.standard;
    const opts = options || {};
    const size = state.size;
    const grid = gridFromState(state);
    const legal = E.DIRECTIONS.filter((direction) => slide(grid, size, direction));
    if (!legal.length) return null;

    const started = Date.now();

    if (config.randomness && Math.random() < config.randomness) {
      const direction = legal[Math.floor(Math.random() * legal.length)];
      return { direction, score: 0, depth: 0, elapsedMs: Date.now() - started };
    }

    const maxSpawnCells = size <= 4 ? 6 : 4;
    const budget = opts.budgetMs === undefined ? config.budgetMs : opts.budgetMs;

    if (!budget) {
      const context = { deadline: 0, nodes: 0, nodeLimit: Infinity, maxSpawnCells, timedOut: false };
      const result = searchMove(grid, size, config.depth, context);
      return {
        direction: result.direction || legal[0],
        score: result.score,
        depth: config.depth,
        elapsedMs: Date.now() - started,
      };
    }

    const deadline = started + budget;
    let best = { direction: legal[0], score: -Infinity };
    let reached = 0;
    for (let depth = 2; depth <= config.depth; depth += 1) {
      const context = {
        deadline,
        nodes: 0,
        nodeLimit: opts.nodeLimit || NODE_LIMIT,
        maxSpawnCells,
        timedOut: false,
      };
      const result = searchMove(grid, size, depth, context);
      if (context.timedOut && reached) break;
      if (result.direction) {
        best = result;
        reached = depth;
      }
      if (Date.now() > deadline) break;
    }
    return {
      direction: best.direction || legal[0],
      score: best.score,
      depth: reached,
      elapsedMs: Date.now() - started,
    };
  }

  return {
    LEVELS, WEIGHTS, NODE_LIMIT,
    gridFromState, slide, collapse, evaluate,
    monotonicity, smoothness, countEmpty, adjacentMerges,
    chooseMove,
  };
});
