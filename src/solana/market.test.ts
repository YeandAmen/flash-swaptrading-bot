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

test('a negative depth curve gets one exploratory step below the discovery grid', () => {
  const planner = new SolanaMarketPlanner(3);
  const discovery = new Set<string>();
  let exploratory = 0, largerRefinements = 0;
  for (let scan = 0; scan < 147; scan++) {
    const now = scan * 12_240;
    const probe = planner.plan(2500, now);
    if (probe.reason === 'discovery') discovery.add(`${probe.venue}/${probe.loanUsdc}`);
    else {
      assert.equal(scan % 4, 3);
      assert.ok(probe.lead && probe.lead.loanUsdc >= 25);
      if (probe.loanUsdc < 25) {
        assert.equal(probe.loanUsdc, 15.625);
        exploratory++;
      } else largerRefinements++;
    }
    // A small negative spread widens with price impact. At $1.490115 the best pair would return -286 micro-USDC.
    const lossBps = [7, 9, 1.9][probe.venue] + 0.014 * probe.loanUsdc;
    planner.record(probe, -Math.round(probe.loanUsdc * lossBps * 100) / 1_000_000, now);
  }
  assert.equal(discovery.size, 9);
  assert.ok(exploratory > 0 && largerRefinements > 0);
  assert.equal(exploratory + largerRefinements, 36, 'another fresh lead uses each available fourth poll in this fixture');
});

test('a sub-grid result must be positive to drive the next optional poll', () => {
  for (const net of [-0.003, 0, 0.064922]) {
    const planner = new SolanaMarketPlanner(3);
    for (let scan = 0; scan < 7; scan++) {
      const now = scan * 12_000;
      const probe = planner.plan(2500, now);
      if (scan === 0) planner.record(probe, -0.012346, now);  // $25 near miss
      if (scan === 3) {
        assert.equal(probe.loanUsdc, 15.625);
        planner.record(probe, net, now);
      }
    }
    // The original $25 sample is stale. The $15.625 sample is still fresh.
    const next = planner.plan(2500, 84_000);
    if (net > 0) {
      assert.equal(next.reason, 'refinement');
      assert.equal(next.lead?.loanUsdc, 15.625);
      assert.equal(next.loanUsdc, 25);
    } else assert.equal(next.reason, 'discovery');
  }
});

test('negative refinement uses the rounded shallow amount of the current cap', () => {
  for (const [initialCap, nextCap, net, nextSize] of [
    [100.000019, 100.000019, -0.001, 3.125],  // rounded shallow amount equals $5
    [10, 10, -0.001, 1.6],                    // shallow amount is clamped to $1
    [10, 2500, -0.001, 250],                   // old $1 near miss falls below the new grid
    [10, 2500, 0.001, 1.6],                    // an old positive is still a valid lead
    [2500, 10, 0.01, Math.floor(Math.sqrt(10) * 1_000_000) / 1_000_000],
  ]) {
    const planner = new SolanaMarketPlanner(3);
    for (let scan = 0; scan < 3; scan++) {
      const probe = planner.plan(initialCap, scan * 12_000);
      if (scan === 0) planner.record(probe, net, 0);
    }
    const next = planner.plan(nextCap, 36_000);
    assert.equal(next.loanUsdc, nextSize);
    assert.ok(next.loanUsdc >= 1 && next.loanUsdc <= nextCap);
  }
});
