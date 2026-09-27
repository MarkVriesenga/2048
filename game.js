/* 2048 UI — wires the rules engine and AI player to the DOM. */
(function () {
  'use strict';

  const E = window.Game2048Engine;
  const AI = window.Game2048AI;
  const $ = (selector) => document.querySelector(selector);

  const boardElement = $('#board');
  const cellsElement = $('#grid-cells');
  const tileLayer = $('#tile-layer');

  const MOVE_MS = 130;          // must match the tile transition in styles.css
  const MAX_UNDO = 60;
  const DIRECTION_LABEL = { up: 'Up', right: 'Right', down: 'Down', left: 'Left' };
  const KEYS = {
    ArrowUp: E.UP, ArrowRight: E.RIGHT, ArrowDown: E.DOWN, ArrowLeft: E.LEFT,
    w: E.UP, d: E.RIGHT, s: E.DOWN, a: E.LEFT,
    k: E.UP, l: E.RIGHT, j: E.DOWN, h: E.LEFT,
  };

  let game = null;           // engine state
  let history = [];          // engine states before each move, for undo
  let setup = null;          // options locked in at New game
  let hintDirection = null;  // suggested direction, marked in green
  let autoplayTimer = null;
  let autoplayOn = false;    // the AI is driving the board
  let paused = false;
  let lastSearch = null;     // telemetry from the AI's most recent decision
  let muted = false;
  let busy = false;          // a move animation is in flight
  let queued = null;         // one buffered direction, so fast play never drops a key
  let resultShown = false;
  const tileNodes = new Map();
  let audio = null;

  /* --- persistence: one best score per board size and target --- */

  const bestKey = (size, target) => '2048-best-' + size + 'x' + size + '-' + target;

  function readBest(size, target) {
    try {
      return parseInt(window.localStorage.getItem(bestKey(size, target)), 10) || 0;
    } catch (error) {
      return 0;
    }
  }

  function writeBest(size, target, score) {
    try {
      window.localStorage.setItem(bestKey(size, target), String(score));
    } catch (error) {
      /* storage unavailable (private window); the score simply is not kept */
    }
  }

  /* --- sound --- */

  function beep(frequency, duration, gain) {
    if (muted) return;
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audio.createOscillator();
      const amp = audio.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = frequency;
      amp.gain.value = gain;
      amp.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
      oscillator.connect(amp).connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + duration);
    } catch (error) {
      muted = true;
    }
  }

  /* --- board rendering --- */

  function buildGrid(size) {
    boardElement.style.setProperty('--n', size);
    cellsElement.innerHTML = '';
    for (let i = 0; i < size * size; i += 1) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cellsElement.appendChild(cell);
    }
    tileLayer.innerHTML = '';
    tileNodes.clear();
    sizeTileText();
  }

  /* Tile text scales with the rendered board, so 6×6 stays readable. */
  function sizeTileText() {
    if (!game) return;
    const width = boardElement.clientWidth || 480;
    boardElement.style.setProperty('--tile-font', Math.round((width / game.size) * 0.4));
  }

  function tileClass(value) {
    const classes = ['tile', 'v' + value];
    if (value > 2048) classes.push('huge');
    if (value >= 1024) classes.push('wide');
    return classes.join(' ');
  }

  function placeNode(node, row, col) {
    node.style.setProperty('--row', row);
    node.style.setProperty('--col', col);
  }

  function makeNode(tile, row, col) {
    const node = document.createElement('div');
    node.className = tileClass(tile.value);
    node.textContent = tile.value;
    node.style.setProperty('--n', game.size);
    placeNode(node, row, col);
    return node;
  }

  /*
   * Draw the board from the engine state. Tiles that survived a move keep their
   * DOM node and slide via the CSS transition; merged tiles are drawn as their
   * two sources sliding together, then replaced by the doubled tile.
   */
  function render(animate) {
    const live = new Set();
    const pending = [];

    for (const tile of E.tiles(game)) {
      if (tile.mergedFrom && animate) {
        for (const source of tile.mergedFrom) {
          const node = tileNodes.get(source.id);
          if (node) {
            live.add(source.id);
            requestAnimationFrame(() => placeNode(node, tile.row, tile.col));
            pending.push(source.id);
          }
        }
        const merged = makeNode(tile, tile.row, tile.col);
        merged.classList.add('merged');
        merged.style.animationDelay = MOVE_MS + 'ms';
        tileLayer.appendChild(merged);
        tileNodes.set(tile.id, merged);
        live.add(tile.id);
        continue;
      }

      let node = tileNodes.get(tile.id);
      if (!node) {
        node = makeNode(tile, animate ? tile.prevRow : tile.row, animate ? tile.prevCol : tile.col);
        if (tile.isNew) {
          node.classList.add('appear');
          node.style.animationDelay = animate ? MOVE_MS + 'ms' : '0ms';
        }
        tileLayer.appendChild(node);
        tileNodes.set(tile.id, node);
      }
      node.className = tileClass(tile.value) + (node.classList.contains('appear') ? ' appear' : '');
      node.textContent = tile.value;
      if (animate) requestAnimationFrame(() => placeNode(node, tile.row, tile.col));
      else placeNode(node, tile.row, tile.col);
      live.add(tile.id);
    }

    for (const [id, node] of Array.from(tileNodes.entries())) {
      if (live.has(id)) continue;
      node.remove();
      tileNodes.delete(id);
    }

    if (pending.length) {
      window.setTimeout(() => {
        for (const id of pending) {
          const node = tileNodes.get(id);
          if (node) {
            node.remove();
            tileNodes.delete(id);
          }
        }
      }, MOVE_MS);
    }
  }

  /* --- panels --- */

  function bar(element, filled, total) {
    element.innerHTML = '';
    for (let i = 0; i < total; i += 1) {
      const segment = document.createElement('i');
      if (i >= filled) segment.className = 'dim';
      element.appendChild(segment);
    }
  }

  function updatePanels() {
    const free = E.emptyCells(game).length;
    const total = game.size * game.size;
    const best = Math.max(game.best, readBest(game.size, game.target));

    $('#score').textContent = game.score;
    $('#best-score').textContent = best;
    $('#largest-tile').textContent = game.largest;
    $('#free-cells').textContent = free + ' / ' + total;
    $('#move-counter').textContent = 'MOVE ' + String(game.moveCount).padStart(2, '0');
    $('#grid-label').textContent = game.size + '×' + game.size;
    $('#mode-badge').textContent = game.size + '×' + game.size + ' · TARGET ' + game.target;
    $('#best-card').classList.toggle('active', game.score > 0 && game.score >= best);
    $('#record-chip').classList.toggle('hidden', !(game.score > 0 && game.score >= best));

    const progress = Math.min(8, Math.round((Math.log2(game.largest || 2) / Math.log2(game.target)) * 8));
    bar($('#score-bar'), progress, 8);
    bar($('#best-bar'), Math.min(8, Math.round((best ? Math.log2(best) : 0) / 2)), 8);

    $('#undo-button').disabled = !history.length || busy;
    $('#game-state').textContent = game.over
      ? 'GAME OVER'
      : game.won && !game.keepPlaying
        ? 'TARGET REACHED'
        : 'GAME IN PROGRESS';

    if (game.over) {
      $('#status-title').textContent = 'No moves remain';
      $('#board-hint').textContent = 'The grid is locked — start a new game, or undo your last move.';
    } else if (autoplayOn) {
      $('#status-title').textContent = paused ? 'Autoplay paused' : 'AI is playing';
      $('#board-hint').textContent = 'Watching ' + AI_LABEL[setup.level] + ' play the ' + game.size + '×' + game.size + ' grid.';
    } else if (game.moveCount === 0) {
      $('#status-title').textContent = 'Slide to begin';
      $('#board-hint').textContent = 'Arrow keys, WASD or swipe to play. Space plays one AI move, G hands the board over.';
    } else {
      $('#status-title').textContent = DIRECTION_LABEL[game.lastDirection] + ' · ' + game.largest + ' banked';
      $('#board-hint').textContent = game.lastGain
        ? 'Merged for ' + game.lastGain + ' points. Keep the big tile in its corner.'
        : 'No merge that move — look for a direction that lines up a pair.';
    }

    $('#ai-stat').textContent = lastSearch
      ? AI_LABEL[lastSearch.level].toUpperCase() + ' · ' +
        (lastSearch.depth ? 'D' + lastSearch.depth + ' · ' : '') +
        lastSearch.elapsedMs + 'MS'
      : 'IDLE';
    $('#autoplay-button').textContent = autoplayOn ? 'Autoplay · stop the AI' : 'Autoplay · AI takes over';
    $('#pause-button').hidden = !autoplayOn;
    $('#pause-button').textContent = paused ? 'Resume' : 'Pause';
    $('#hint-button').disabled = autoplayOn || game.over;
    $('#step-button').disabled = autoplayOn || game.over || busy;
    $('#autoplay-button').disabled = game.over;

    const gainChip = $('#gain-chip');
    gainChip.textContent = '+' + game.lastGain;
    gainChip.classList.toggle('hidden', !game.lastGain);
    boardElement.classList.toggle('locked', game.over);
  }

  const AI_LABEL = { casual: 'Casual', standard: 'Standard', expert: 'Expert' };

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => element.classList.remove('show'), 2000);
  }

  function clearHint() {
    if (!hintDirection) return;
    boardElement.classList.remove('hint-' + hintDirection);
    hintDirection = null;
  }

  /* --- setup --- */

  function targetChoices(size) {
    const choices = [];
    const start = size === 3 ? 64 : 256;
    const top = E.DEFAULT_TARGETS[size] * 4;
    for (let value = start; value <= top; value *= 2) choices.push(value);
    return choices;
  }

  function fillTargets() {
    const size = parseInt($('#size-select').value, 10);
    const select = $('#target-select');
    const preferred = E.DEFAULT_TARGETS[size];
    select.innerHTML = '';
    for (const value of targetChoices(size)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value + (value === preferred ? ' · standard' : '');
      if (value === preferred) option.selected = true;
      select.appendChild(option);
    }
  }

  function readSetup() {
    return {
      size: parseInt($('#size-select').value, 10),
      target: parseInt($('#target-select').value, 10),
      level: $('#level-select').value,                // 'casual' | 'standard' | 'expert'
      speed: parseInt($('#speed-select').value, 10),
    };
  }

  /* --- game flow --- */

  function newGame() {
    stopAutoplay();
    setup = readSetup();
    game = E.newGame({ size: setup.size, target: setup.target, best: readBest(setup.size, setup.target) });
    lastSearch = null;
    history = [];
    queued = null;
    resultShown = false;
    paused = false;
    busy = false;
    clearHint();
    buildGrid(game.size);
    render(false);
    updatePanels();
    if (autoplayOn) scheduleAutoplay();
  }

  function pushHistory() {
    history.push(E.clone(game));
    if (history.length > MAX_UNDO) history.shift();
  }

  function play(direction) {
    if (!game || (game.over && !game.keepPlaying)) return false;
    if (busy) {
      queued = direction;   // played as soon as the current slide finishes
      return false;
    }
    if (!E.wouldChange(game, direction)) {
      if (!autoplayOn) toast('Nothing moves that way.');
      return false;
    }

    clearHint();
    pushHistory();
    const report = E.move(game, direction);
    busy = true;
    render(true);
    if (report.merges) beep(180 + Math.min(660, Math.log2(report.largest) * 60), 0.09, 0.05);
    else beep(140, 0.05, 0.025);

    window.setTimeout(() => {
      busy = false;
      updatePanels();
      if (game.best > readBest(game.size, game.target)) writeBest(game.size, game.target, game.best);
      if (report.won && !game.keepPlaying) showResult(true);
      else if (report.over) showResult(false);
      const next = queued;
      queued = null;
      if (next && !game.over) play(next);
    }, MOVE_MS + 40);

    updatePanels();
    return true;
  }

  function undo() {
    if (busy || !history.length) return;
    if (autoplayOn) {
      paused = true;   // undoing while the AI drives pauses it, rather than fighting it
      stopAutoplay();
    }
    game = history.pop();
    queued = null;
    resultShown = false;
    clearHint();
    tileNodes.clear();
    tileLayer.innerHTML = '';
    render(false);
    updatePanels();
    toast('Move undone.');
  }

  function suggest() {
    if (busy || game.over) return;
    const choice = AI.chooseMove(game, 'expert');
    if (!choice) {
      toast('No legal move remains.');
      return;
    }
    lastSearch = { level: 'expert', depth: choice.depth, elapsedMs: choice.elapsedMs };
    clearHint();
    hintDirection = choice.direction;
    boardElement.classList.add('hint-' + hintDirection);
    toast('Expert AI suggests ' + DIRECTION_LABEL[hintDirection].toLowerCase() + '.');
  }

  /* --- autoplay: the AI drives the board at the chosen strength and speed --- */

  function scheduleAutoplay() {
    window.clearTimeout(autoplayTimer);
    if (!autoplayOn || paused || game.over) return;
    autoplayTimer = window.setTimeout(autoplayStep, Math.max(setup.speed, MOVE_MS + 30));
  }

  function autoplayStep() {
    if (!autoplayOn || paused || game.over) return;
    if (busy) {            // a slide is still animating; look again next tick
      scheduleAutoplay();
      return;
    }
    if (!aiMove()) {
      setAutoplay(false);
      return;
    }
    scheduleAutoplay();
  }

  /*
   * Let the AI choose and play a single move. Returns false when no legal move
   * remains, which is also how autoplay learns the game has ended.
   */
  function aiMove() {
    if (game.over && !game.keepPlaying) return false;
    const choice = AI.chooseMove(game, setup.level);
    if (!choice) {
      showResult(false);
      return false;
    }
    lastSearch = { level: setup.level, depth: choice.depth, elapsedMs: choice.elapsedMs };
    clearHint();
    return play(choice.direction);
  }

  function setAutoplay(on) {
    autoplayOn = on;
    paused = false;
    stopAutoplay();
    if (autoplayOn) {
      clearHint();
      toast(AI_LABEL[setup.level] + ' AI is playing — press Stop or any arrow key to take over.');
      scheduleAutoplay();
    } else {
      lastSearch = null;
      toast('Autoplay stopped — the board is yours.');
    }
    updatePanels();
  }

  function togglePause() {
    if (!autoplayOn) return;
    paused = !paused;
    if (paused) stopAutoplay();
    else scheduleAutoplay();
    updatePanels();
  }

  function stopAutoplay() {
    window.clearTimeout(autoplayTimer);
    autoplayTimer = null;
  }

  /* --- result --- */

  function showResult(won) {
    if (resultShown) return;
    resultShown = true;
    stopAutoplay();
    if (game.over) {
      autoplayOn = false;
      paused = false;
    }
    const best = Math.max(game.best, readBest(game.size, game.target));
    $('#result-eyebrow').textContent = won
      ? 'TARGET REACHED · ' + game.target + ' BUILT'
      : 'GAME OVER · NO MOVES REMAIN';
    $('#result-title').textContent = won ? 'You built ' + game.target : 'Board locked';
    $('#result-detail').textContent = won
      ? 'Reached in ' + game.moveCount + ' moves on the ' + game.size + '×' + game.size + ' grid. Keep playing to push the score further.'
      : 'The ' + game.size + '×' + game.size + ' grid filled after ' + game.moveCount + ' moves.' +
        (game.score >= best ? ' That is your best on this grid.' : ' Best on this grid: ' + best + '.');
    $('#result-score').textContent = game.score;
    $('#result-largest').textContent = game.largest;
    $('#result-largest-note').textContent = won ? 'LARGEST TILE' : 'LARGEST TILE';
    $('#result-continue').hidden = !won;
    beep(won ? 660 : 120, won ? 0.3 : 0.22, 0.06);
    $('#result-dialog').showModal();
  }

  /* --- input --- */

  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.activeElement && document.activeElement.tagName === 'SELECT') return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const direction = KEYS[key];
    if (direction) {
      event.preventDefault();
      if (autoplayOn) setAutoplay(false);   // taking the board back from the AI
      play(direction);
      return;
    }
    if (key === 'u') undo();
    if (key === 'n') newGame();
    if (key === 'p' && autoplayOn) togglePause();
    if (key === 'g') setAutoplay(!autoplayOn);
    if (key === ' ' && !autoplayOn) {
      event.preventDefault();
      aiMove();
    }
  }

  let touchStart = null;

  function onTouchStart(event) {
    const point = event.touches ? event.touches[0] : event;
    touchStart = { x: point.clientX, y: point.clientY };
  }

  function onTouchEnd(event) {
    if (!touchStart) return;
    const point = event.changedTouches ? event.changedTouches[0] : event;
    const dx = point.clientX - touchStart.x;
    const dy = point.clientY - touchStart.y;
    touchStart = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (autoplayOn) setAutoplay(false);
    if (Math.abs(dx) > Math.abs(dy)) play(dx > 0 ? E.RIGHT : E.LEFT);
    else play(dy > 0 ? E.DOWN : E.UP);
  }

  /* --- wiring --- */

  fillTargets();

  $('#size-select').addEventListener('change', () => {
    fillTargets();
    newGame();
  });
  $('#target-select').addEventListener('change', newGame);
  $('#speed-select').addEventListener('change', () => {
    setup.speed = parseInt($('#speed-select').value, 10);
  });
  $('#level-select').addEventListener('change', () => {
    setup.level = $('#level-select').value;
    if (autoplayOn) toast('AI strength set to ' + AI_LABEL[setup.level] + '.');
    updatePanels();
  });

  $('#new-game').addEventListener('click', newGame);
  $('#undo-button').addEventListener('click', undo);
  $('#hint-button').addEventListener('click', suggest);
  $('#autoplay-button').addEventListener('click', () => setAutoplay(!autoplayOn));
  $('#step-button').addEventListener('click', () => {
    if (!aiMove()) toast('No legal move remains.');
  });
  $('#pause-button').addEventListener('click', togglePause);

  $('#rules-button').addEventListener('click', () => $('#rules-dialog').showModal());
  $('#close-rules').addEventListener('click', () => $('#rules-dialog').close());
  $('#result-close').addEventListener('click', () => $('#result-dialog').close());
  $('#result-new').addEventListener('click', () => {
    $('#result-dialog').close();
    newGame();
  });
  $('#result-continue').addEventListener('click', () => {
    $('#result-dialog').close();
    game.keepPlaying = true;
    resultShown = false;
    updatePanels();
    if (autoplayOn) scheduleAutoplay();
  });

  $('#sound-button').addEventListener('click', (event) => {
    muted = !muted;
    event.currentTarget.classList.toggle('muted', muted);
    toast(muted ? 'Sound off.' : 'Sound on.');
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', sizeTileText);
  boardElement.addEventListener('touchstart', onTouchStart, { passive: true });
  boardElement.addEventListener('touchend', onTouchEnd, { passive: true });
  boardElement.addEventListener('mousedown', onTouchStart);
  boardElement.addEventListener('mouseup', onTouchEnd);

  newGame();
})();
