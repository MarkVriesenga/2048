/* AI tests. Run: node tests/ai.test.js */
'use strict';
const assert = require('assert');
const E = require('../engine.js');
const AI = require('../ai.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

/* Play a whole game with the given level and report how it ended. */
function playGame(size, level, seed, budgetMs) {
  const state = E.newGame({ size, seed });
  let moves = 0;
  while (!state.over && moves < 5000) {
    const choice = AI.chooseMove(state, level, budgetMs === undefined ? {} : { budgetMs });
    if (!choice) break;
    assert.ok(E.wouldChange(state, choice.direction), `${level} picked an illegal move`);
    E.move(state, choice.direction);
    moves += 1;
  }
  return { score: state.score, largest: state.largest, moves, state };
}

console.log('grid simulation matches the engine');
test('AI.slide reproduces engine moves exactly, on every size', () => {
  for (const size of E.SIZES) {
    const state = E.newGame({ size, seed: size * 104729 });
    for (let step = 0; step < 120 && !state.over; step += 1) {
      const grid = AI.gridFromState(state);
      for (const direction of E.DIRECTIONS) {
        const simulated = AI.slide(grid, size, direction);
        assert.strictEqual(
          !!simulated,
          E.wouldChange(state, direction),
          `legality disagreed on ${size}×${size} ${direction}`
        );
        if (!simulated) continue;
        const copy = E.clone(state);
        const report = E.move(copy, direction);
        assert.strictEqual(simulated.gained, report.gained, 'score gain disagreed');
        // The engine spawns a tile after moving; compare everything except that cell.
        const after = AI.gridFromState(copy);
        const spawned = report.spawned.row * size + report.spawned.col;
        for (let i = 0; i < after.length; i += 1) {
          if (i === spawned) continue;
          assert.strictEqual(after[i], simulated.grid[i], `cell ${i} disagreed`);
        }
      }
      E.move(state, E.availableMoves(state)[0]);
    }
  }
});

test('collapse follows the one-merge-per-tile rule', () => {
  assert.deepStrictEqual(AI.collapse([2, 2, 2, 2]).line, [4, 4, 0, 0]);
  assert.deepStrictEqual(AI.collapse([4, 2, 2, 0]).line, [4, 4, 0, 0]);
  assert.deepStrictEqual(AI.collapse([2, 0, 0, 2]).line, [4, 0, 0, 0]);
  assert.deepStrictEqual(AI.collapse([2, 4, 8]).line, [2, 4, 8]);
  assert.strictEqual(AI.collapse([2, 2, 4, 4]).gained, 12);
});

console.log('move selection');
test('every level returns a legal move, or null when none exists', () => {
  for (const level of Object.keys(AI.LEVELS)) {
    for (const size of E.SIZES) {
      const state = E.newGame({ size, seed: 5150 + size });
      const choice = AI.chooseMove(state, level);
      assert.ok(choice, `${level} found a move on ${size}×${size}`);
      assert.ok(E.DIRECTIONS.indexOf(choice.direction) !== -1);
      assert.ok(E.wouldChange(state, choice.direction));
    }
  }
  const locked = E.fromGrid([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
  assert.strictEqual(AI.chooseMove(locked, 'expert'), null);
});

test('the search takes the merge that is free', () => {
  const state = E.fromGrid([
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [64, 64, 0, 0],
  ]);
  const choice = AI.chooseMove(state, 'standard');
  assert.ok(choice.direction === E.LEFT || choice.direction === E.RIGHT, 'merged the pair');
});

test('choosing a move never mutates the state it was given', () => {
  const state = E.newGame({ size: 5, seed: 2024 });
  const before = E.valueGrid(state);
  const score = state.score;
  AI.chooseMove(state, 'expert');
  assert.deepStrictEqual(E.valueGrid(state), before);
  assert.strictEqual(state.score, score);
});

test('expert respects its time budget per move', () => {
  const state = E.newGame({ size: 6, seed: 88 });
  const started = Date.now();
  const choice = AI.chooseMove(state, 'expert', { budgetMs: 60 });
  const elapsed = Date.now() - started;
  assert.ok(choice.direction);
  assert.ok(elapsed < 600, `took ${elapsed}ms, budget was 60ms`);
});

test('a node cap stops the search even when the clock never advances', () => {
  const state = E.newGame({ size: 6, seed: 4004 });
  const started = Date.now();
  const choice = AI.chooseMove(state, 'expert', { budgetMs: 60, nodeLimit: 200 });
  assert.ok(choice.direction, 'still returned a move');
  assert.ok(E.wouldChange(state, choice.direction), 'and a legal one');
  assert.ok(Date.now() - started < 400, 'the node cap ended the search quickly');
});

console.log('evaluation');
test('an ordered board with the big tile in a corner beats a scattered one', () => {
  const tidy = [
    64, 32, 16, 8,
    32, 16, 8, 4,
    16, 8, 4, 2,
    8, 4, 2, 0,
  ];
  const messy = [
    2, 64, 4, 8,
    16, 2, 32, 2,
    4, 8, 2, 16,
    32, 4, 8, 2,
  ];
  assert.ok(AI.evaluate(tidy, 4) > AI.evaluate(messy, 4));
  assert.strictEqual(AI.countEmpty(tidy), 1);
  assert.strictEqual(AI.adjacentMerges(messy) === undefined, false);
});

console.log('strength (full games — this takes a moment)');
test('standard outplays casual on the classic 4×4 grid', () => {
  let standard = 0;
  let casual = 0;
  for (const seed of [11, 22, 33]) {
    standard += playGame(4, 'standard', seed).score;
    casual += playGame(4, 'casual', seed).score;
  }
  console.log(`      standard ${standard} vs casual ${casual} over 3 games`);
  assert.ok(standard > casual, 'standard scored higher in total');
});

test('expert builds a big tile on the classic grid', () => {
  const result = playGame(4, 'expert', 4242, 40);
  console.log(`      expert reached ${result.largest} scoring ${result.score} in ${result.moves} moves`);
  assert.ok(result.largest >= 256, `largest tile was ${result.largest}`);
});

test('every size plays through to a finished game under the AI', () => {
  for (const size of E.SIZES) {
    const result = playGame(size, 'standard', size * 61);
    assert.ok(result.moves > 10, `size ${size} played ${result.moves} moves`);
    assert.strictEqual(result.state.over || result.state.won, true);
    console.log(`      ${size}×${size}: largest ${result.largest}, score ${result.score}, ${result.moves} moves`);
  }
});

console.log(`\n${passed} AI tests passed`);
