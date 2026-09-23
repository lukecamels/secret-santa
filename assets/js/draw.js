/* Secret Santa - the draw.
 *
 * Two modes:
 *   pairs  - any assignment where nobody draws themselves or an excluded name.
 *   loop   - one single chain through everyone, so no two people ever end up
 *            buying for each other.
 *
 * Both use randomised backtracking, which means a solution is found whenever
 * one exists (a plain reshuffle-until-it-works loop can spin forever on tightly
 * constrained groups).
 */
(function (global) {
  'use strict';

  function shuffled(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function buildAllowed(n, exclusions) {
    var allowed = [];
    for (var i = 0; i < n; i++) {
      allowed.push([]);
      for (var j = 0; j < n; j++) {
        allowed[i].push(i !== j && !exclusions.has(key(i, j)));
      }
    }
    return allowed;
  }

  function key(i, j) { return i < j ? i + '|' + j : j + '|' + i; }

  /* Any valid assignment: bipartite matching, givers -> receivers. */
  function solvePairs(n, allowed) {
    var giveeOf = new Array(n).fill(-1);
    var taken = new Array(n).fill(false);

    function candidates(giver) {
      var out = [];
      for (var j = 0; j < n; j++) if (allowed[giver][j] && !taken[j]) out.push(j);
      return out;
    }

    function step(assignedCount) {
      if (assignedCount === n) return true;

      // Most-constrained giver first: fails fast, keeps the search small.
      var best = -1, bestOptions = null;
      for (var i = 0; i < n; i++) {
        if (giveeOf[i] !== -1) continue;
        var opts = candidates(i);
        if (opts.length === 0) return false;
        if (!bestOptions || opts.length < bestOptions.length) {
          best = i; bestOptions = opts;
          if (opts.length === 1) break;
        }
      }

      var order = shuffled(bestOptions);
      for (var k = 0; k < order.length; k++) {
        giveeOf[best] = order[k];
        taken[order[k]] = true;
        if (step(assignedCount + 1)) return true;
        taken[order[k]] = false;
        giveeOf[best] = -1;
      }
      return false;
    }

    return step(0) ? giveeOf : null;
  }

  /* One single loop: a Hamiltonian cycle over the allowed edges. */
  function solveLoop(n, allowed) {
    var start = crypto.getRandomValues(new Uint32Array(1))[0] % n;
    var path = [start];
    var visited = new Array(n).fill(false);
    visited[start] = true;

    function step() {
      if (path.length === n) return allowed[path[path.length - 1]][start];
      var current = path[path.length - 1];
      var options = [];
      for (var j = 0; j < n; j++) if (allowed[current][j] && !visited[j]) options.push(j);
      options = shuffled(options);
      for (var k = 0; k < options.length; k++) {
        path.push(options[k]);
        visited[options[k]] = true;
        if (step()) return true;
        visited[options[k]] = false;
        path.pop();
      }
      return false;
    }

    if (!step()) return null;
    var giveeOf = new Array(n);
    for (var i = 0; i < n; i++) giveeOf[path[i]] = path[(i + 1) % n];
    return giveeOf;
  }

  /**
   * @param {number} n           number of participants
   * @param {Set<string>} exclusions  unordered "i|j" pairs that must not be matched
   * @param {{singleLoop?: boolean}} options
   * @returns {number[]|null}    giveeOf[giver] = receiver, or null if impossible
   */
  function draw(n, exclusions, options) {
    if (n < 2) return null;
    var allowed = buildAllowed(n, exclusions);
    return (options && options.singleLoop) ? solveLoop(n, allowed) : solvePairs(n, allowed);
  }

  global.SSDraw = { draw: draw, pairKey: key };
})(window);
