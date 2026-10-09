import { describe, expect, it } from 'vitest';
import { wirePath, wireState } from '../src/wireState';
import type { RunNodeStatus } from '../src/runGraph';
import { edgeBezierPath } from '../src/ports';

const status = (state: RunNodeStatus['state']): RunNodeStatus => ({ state });

describe('honest wire execution state', () => {
  it('never animates an idle canvas or an upstream that has no confirmed result', () => {
    expect(wireState({})).toBe('idle');
    expect(wireState({ from: status('done'), to: status('running') })).toBe('idle');
    expect(wireState({ running: true, from: status('running'), to: status('waiting') })).toBe('waiting');
    expect(wireState({ running: true, from: status('waiting'), to: status('running') })).toBe('waiting');
    expect(wireState({ running: true, to: status('running') })).toBe('idle');
  });

  it('animates only a confirmed successful or cached source feeding a running receiver', () => {
    for (const source of ['done', 'cached'] as const) {
      expect(wireState({ running: true, from: status(source), to: status('running') })).toBe('flowing');
      expect(wireState({ running: true, from: status(source), to: status('waiting') })).toBe('waiting');
      expect(wireState({ running: false, from: status(source), to: status('done') })).toBe('delivered');
    }
  });

  it('shows failures, blocked and cancelled endpoints without motion', () => {
    for (const state of ['failed', 'blocked', 'cancelled'] as const) {
      expect(wireState({ running: true, from: status(state), to: status('running') })).toBe(state);
      expect(wireState({ running: true, from: status('done'), to: status(state) })).toBe(state);
    }
    expect(wireState({ running: true, from: { state: 'done', unconfirmed: true }, to: status('running') })).toBe('waiting');
    expect(wireState({ running: true, from: status('done'), to: { state: 'running', unconfirmed: true } })).toBe('waiting');
  });

  it('uses previous-round feedback only when a later-round receiver actually executes', () => {
    for (const round of [0, 1, 1.5, NaN, Infinity]) {
      expect(wireState({ kind: 'feedback', running: true, round, to: status('running') })).toBe('idle');
    }
    expect(wireState({ kind: 'feedback', running: true, round: 2, from: status('waiting'), to: status('running') })).toBe('flowing');
    expect(wireState({ kind: 'feedback', running: false, round: 2, to: status('running') })).toBe('idle');
    expect(wireState({ kind: 'feedback', running: true, round: 2, to: status('waiting') })).toBe('waiting');
    expect(wireState({ kind: 'feedback', round: 2, to: status('done') })).toBe('delivered');
    expect(wireState({ kind: 'feedback', running: true, round: 2, to: status('blocked') })).toBe('blocked');
  });
});

describe('wire geometry', () => {
  it('keeps existing data geometry and routes feedback above tiles from output to input', () => {
    const from = { x: 740, y: 264 };
    const to = { x: 80, y: 164 };
    expect(wirePath(from, to)).toBe(edgeBezierPath(from, to));
    const feedback = wirePath(from, to, true, 100);
    expect(feedback).toBe('M 740 264 C 788 264, 788 48, 788 48 L 32 48 C 32 48, 32 164, 80 164');
  });
});
