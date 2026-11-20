import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountRole, address, getAddressEncoder } from '@solana/kit';
import {
  LIGHTHOUSE, lighthouseAtaFloor, lighthouseLamports, lighthouseTokenAmount, lighthouseTokenFloor, lighthouseTokenHasNoCloseAuthority,
  lighthouseTokenHasNoDelegate, lighthouseTokenOwner,
} from './guard.js';

const owner = address('23g1K6sr2bevNwLYPoB79jzEQtErioYQ8mpUa76xA6yu');
const account = address('DriUa3ZYDFNU9wgAvVoEhFCzPb9DmWntBUbHDrFhg32U');

test('Lighthouse amount instructions use checked u64 and distinguish equality from a lower bound', () => {
  const equality = lighthouseTokenAmount(account, 'equal', 0x0102030405060708n);
  const tokenFloor = lighthouseTokenAmount(account, 'atLeast', 0x0102030405060708n);
  const lamportFloor = lighthouseLamports(owner, 'atLeast', 0x0102030405060708n);
  assert.equal(equality.programAddress, LIGHTHOUSE);
  assert.deepEqual(equality.accounts, [{ address: account, role: AccountRole.READONLY }]);
  assert.equal(Buffer.from(equality.data!).toString('hex'), '090402080706050403020100');
  assert.equal(Buffer.from(tokenFloor.data!).toString('hex'), '090402080706050403020104');
  assert.equal(Buffer.from(lamportFloor.data!).toString('hex'), '050400080706050403020104');
  assert.throws(() => lighthouseLamports(owner, 'equal', -1n), RangeError);
  assert.throws(() => lighthouseTokenAmount(account, 'atLeast', 1n << 64n), RangeError);
});

test('Lighthouse token authority instructions protect the owner, delegate, and close authority', () => {
  const bytes = Buffer.from(getAddressEncoder().encode(owner)).toString('hex');
  assert.equal(Buffer.from(lighthouseTokenOwner(account, owner).data!).toString('hex'), `090401${bytes}00`);
  assert.equal(Buffer.from(lighthouseTokenHasNoDelegate(account).data!).toString('hex'), '0904030000');
  assert.equal(Buffer.from(lighthouseTokenHasNoCloseAuthority(account).data!).toString('hex'), '0904070000');
  const floor = lighthouseTokenFloor(account, 0x0102030405060708n, owner);
  assert.equal(Buffer.from(floor.data!).toString('hex'), `0a04040208070605040302010401${bytes}00030000070000`);
  assert.equal(floor.data!.byteLength, 53);
  const associated = lighthouseAtaFloor(account, 0x0102030405060708n);
  assert.equal(Buffer.from(associated.data!).toString('hex'), '0a04040208070605040302010408030000070000');
  assert.deepEqual(lighthouseTokenFloor(account, 1n), lighthouseTokenAmount(account, 'atLeast', 1n));
});
