import { parentPort, workerData } from 'node:worker_threads';
import { runResearch } from './backtest.js';
import { History, type MarketInfo } from './market.js';

export interface ResearchInput {
  bars: History['bars'];
  market: MarketInfo;
  gasPriceGwei: number;
  ethUsd: number;
  startUsd: number;
}

if (!parentPort) throw new Error('Research must run in a worker');
const input = workerData as ResearchInput;
const history = new History();
history.bars = input.bars;
parentPort.postMessage(await runResearch(history, input.market, input.gasPriceGwei, input.ethUsd, input.startUsd));
