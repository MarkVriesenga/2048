/* Rules-engine tests. Run: node tests/engine.test.js */
'use strict';
const assert = require('assert');
const E = require('../engine.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const grid = (state) => E.valueGrid(state);

console.log('setup');
test('every supported size starts with two tiles of 2 or 4', () => {
  for (const size of E.SIZES) {
    const state = E.newGame({ size, seed: size * 7919 });
    const values = E.tiles(state).map((tile) => tile.value);
    assert.strictEqual(values.length, E.START_TILES, `size ${size}`);
    for (const value of values) assert.ok(value === 2 || value === 4, `bad spawn ${value}`);
    assert.strictEqual(state.cells.length, size * size);
    assert.strictEqual(state.score, 0);
    assert.strictEqual(state.target, E.DEFAULT_TARGETS[size]);
  }
});

test('the same seed replays the same game, a different seed does not', () => {
  const a = E.newGame({ size: 4, seed: 12345 });
  const b = E.newGame({ size: 4, seed: 12345 });
  const c = E.newGame({ size: 4, seed: 999 });
  for (const direction of [E.LEFT, E.UP, E.RIGHT, E.DOWN, E.LEFT]) {
    E.move(a, direction);
    E.move(b, direction);
    E.move(c, direction);
  }
  assert.deepStrictEqual(grid(a), grid(b));
  assert.notDeepStrictEqual(grid(a), grid(c));
});

test('unsupported board sizes are rejected', () => {
  assert.throws(() => E.newGame({ size: 7 }), /unsupported board size/);
  assert.throws(() => E.newGame({ size: 2 }), /unsupported board size/);
});

console.log('sliding');
test('tiles slide the full distance to the wall', () => {
  const state = E.fromGrid([
    [0, 0, 0, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 4, 0],
  ]);
  E.move(state, E.LEFT);
  const rows = grid(state);
  assert.strictEqual(rows[0][0], 2);
  assert.strictEqual(rows[3][0], 4);
});

test('equal tiles merge into their double and score that value', () => {
  const state = E.fromGrid([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const report = E.move(state, E.LEFT);
  assert.strictEqual(grid(state)[0][0], 4);
  assert.strictEqual(report.gained, 4);
  assert.strictEqual(state.score, 4);
  assert.strictEqual(report.merges, 1);
});

test('a merged tile cannot merge again in the same move', () => {
  const state = E.fromGrid([
    [2, 2, 2, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const report = E.move(state, E.LEFT);
  assert.deepStrictEqual(grid(state)[0].slice(0, 2), [4, 4]);
  assert.strictEqual(report.merges, 2);
  assert.strictEqual(report.gained, 8);
});

test('the pair nearest the pushed wall merges first', () => {
  const state = E.fromGrid([
    [4, 2, 2, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  E.move(state, E.LEFT);
  assert.deepStrictEqual(grid(state)[0].slice(0, 2), [4, 4]);

  const right = E.fromGrid([
    [0, 2, 2, 4],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  E.move(right, E.RIGHT);
  assert.deepStrictEqual(grid(right)[0].slice(2), [4, 4]);
});

test('gaps close before merging — distant equal tiles still fuse', () => {
  const state = E.fromGrid([
    [2, 0, 0, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  E.move(state, E.LEFT);
  assert.strictEqual(grid(state)[0][0], 4);
});

test('columns merge the same way as rows', () => {
  const state = E.fromGrid([
    [8, 0, 0, 0],
    [8, 0, 0, 0],
    [4, 0, 0, 0],
    [4, 0, 0, 0],
  ]);
  E.move(state, E.UP);
  const column = grid(state).map((row) => row[0]);
  assert.deepStrictEqual(column.slice(0, 2), [16, 8]);
});

console.log('legality and spawning');
test('a direction that changes nothing is illegal and leaves the state alone', () => {
  const state = E.fromGrid([
    [2, 4, 8, 16],
    [4, 8, 16, 32],
    [8, 16, 32, 64],
    [16, 32, 64, 128],
  ]);
  const before = grid(state);
  assert.strictEqual(E.wouldChange(state, E.LEFT), false);
  assert.strictEqual(E.move(state, E.LEFT), null);
  assert.deepStrictEqual(grid(state), before);
  assert.strictEqual(state.moveCount, 0);
});

test('a legal move spawns exactly one new tile', () => {
  for (const size of E.SIZES) {
    const state = E.newGame({ size, seed: 42 + size });
    const before = E.tiles(state).length;
    const direction = E.availableMoves(state)[0];
    const report = E.move(state, direction);
    const after = E.tiles(state).length;
    assert.ok(report.spawned, 'a tile spawned');
    assert.strictEqual(after, before - report.merges + 1, `size ${size}`);
  }
});

test('an unknown direction is an error', () => {
  const state = E.newGame({ size: 4, seed: 1 });
  assert.throws(() => E.move(state, 'sideways'), /unknown direction/);
});

console.log('tile identity');
test('a surviving tile keeps its id and remembers where it came from', () => {
  const state = E.fromGrid([
    [0, 0, 0, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const id = E.tileAt(state, 0, 3).id;
  E.move(state, E.LEFT);
  const moved = E.tileAt(state, 0, 0);
  assert.strictEqual(moved.id, id);
  assert.strictEqual(moved.prevCol, 3);
  assert.strictEqual(moved.mergedFrom, null);
});

test('a merged tile records both sources', () => {
  const state = E.fromGrid([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  E.move(state, E.LEFT);
  const merged = E.tileAt(state, 0, 0);
  assert.strictEqual(merged.value, 4);
  assert.strictEqual(merged.mergedFrom.length, 2);
  for (const source of merged.mergedFrom) assert.strictEqual(source.value, 2);
});

console.log('game end');
test('game over only when the board is full with no matching neighbours', () => {
  const locked = E.fromGrid([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
  assert.strictEqual(E.canMove(locked), false);
  assert.strictEqual(locked.over, true);
  assert.deepStrictEqual(E.availableMoves(locked), []);

  const full = E.fromGrid([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 4],
  ]);
  assert.strictEqual(E.canMove(full), true);
  assert.ok(E.availableMoves(full).length > 0);
});

test('reaching the target wins but play may continue', () => {
  const state = E.fromGrid([
    [1024, 1024, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ], { target: 2048 });
  const report = E.move(state, E.LEFT);
  assert.strictEqual(report.won, true);
  assert.strictEqual(state.won, true);
  assert.strictEqual(state.over, false);
  state.keepPlaying = true;
  assert.ok(E.move(state, E.availableMoves(state)[0]));
});

test('a finished game refuses further moves unless play continues', () => {
  const state = E.fromGrid([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
  assert.strictEqual(E.move(state, E.LEFT), null);
});

console.log('cloning');
test('a clone is independent and replays the same spawns', () => {
  const state = E.newGame({ size: 5, seed: 777 });
  const copy = E.clone(state);
  E.move(state, E.availableMoves(state)[0]);
  assert.notDeepStrictEqual(grid(state), grid(copy), 'the original changed');

  const again = E.clone(copy);
  const direction = E.availableMoves(copy)[0];
  E.move(copy, direction);
  E.move(again, direction);
  assert.deepStrictEqual(grid(copy), grid(again));
  assert.strictEqual(copy.score, again.score);
});

console.log('full games');
test('random play on every size terminates with a consistent final state', () => {
  for (const size of E.SIZES) {
    const state = E.newGame({ size, seed: size * 31337 });
    let moves = 0;
    while (!state.over && moves < 20000) {
      const options = E.availableMoves(state);
      assert.ok(options.length, 'availableMoves agrees with canMove');
      E.move(state, options[moves % options.length]);
      moves += 1;
    }
    assert.strictEqual(state.over, true, `size ${size} finished`);
    assert.strictEqual(E.canMove(state), false);
    assert.strictEqual(E.emptyCells(state).length, 0);
    assert.strictEqual(E.tiles(state).length, size * size);
    assert.ok(state.score > 0 && state.largest >= 8, `size ${size} scored`);
  }
});

console.log(`\n${passed} engine tests passed`);
