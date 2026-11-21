import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SolanaMarketPlanner } from './market.js';

test('Solana discovers all venue and depth combinations even with a persistent positive lead', () => {
  const planner = new SolanaMarketPlanner(3);
  const limit = 250.1234569;
  const coverage = [new Set<number>(), new Set<number>(), new Set<number>()];
  let refinements = 0;
  for (let scan = 0; scan < 12; scan++) {
    const now = 12_000 * scan;
    const plan = planner.plan(limit, now);
    assert.ok(plan.loanUsdc >= 1 && plan.loanUsdc <= limit);
    if (plan.reason === 'discovery') coverage[plan.venue].add(plan.loanUsdc);
    else refinements++;
    planner.record(plan, plan.venue === 0 ? 1 : -plan.loanUsdc / 1000, now);
  }
  assert.ok(refinements > 0);
  for (const venue of coverage) {
    assert.equal(venue.size, 3);
    assert.ok(venue.has(250.123456));
  }
});

test('Solana refinement picks a new adjacent size from the best fresh positive quote', () => {
  const planner = new SolanaMarketPlanner(3);
  for (const [venue, net] of [0.01, 0.5, -0.001].entries()) {
    const plan = planner.plan(250, venue * 12_000);
    assert.equal(plan.venue, venue);
    planner.record(plan, net, venue * 12_000);
  }
  const refinement = planner.plan(250, 36_000);
  assert.equal(refinement.reason, 'refinement');
  assert.equal(refinement.venue, 1);
  assert.equal(refinement.loanUsdc, 20);
  assert.equal(refinement.lead?.quotedNetUsdc, 0.5);
});

test('a larger Solana cap keeps a shallow and mid-sized market probe', () => {
  const planner = new SolanaMarketPlanner(3);
  const sizes = new Set(Array.from({ length: 9 }, (_, scan) => planner.plan(2500, scan * 12_000).loanUsdc));
  assert.deepEqual(sizes, new Set([25, 250, 2500]));
});

test('Solana sweeps instead of refining stale, deeply negative, or unmarketable sizes', () => {
  const planner = new SolanaMarketPlanner(3);
  planner.record(planner.plan(250, 0), 5, 0);
  planner.record(planner.plan(250, 55_000), -5, 55_000);
  planner.record(planner.plan(250, 60_000), undefined, 60_000);
  assert.equal(planner.plan(250, 72_000).reason, 'discovery');

  const minimum = new SolanaMarketPlanner(3);
  for (let scan = 0; scan < 4; scan++) {
    const plan = minimum.plan(1.0000009, 12_000 * scan);
    assert.equal(plan.reason, 'discovery');
    assert.equal(plan.loanUsdc, 1);
    minimum.record(plan, 1, 12_000 * scan);
  }
});
