// Viewport culling: which world-space boxes intersect the visible rect, so the renderer can
// skip off-screen tiles. The visible world rect is the viewport inverse-transformed, padded
// by a margin so partially-visible and near-edge tiles are not popped in and out.
import { describe, expect, it } from 'vitest';
import { visibleBoxIds } from '../src/viewport';

const size = { w: 1000, h: 800 };

describe('visibleBoxIds', () => {
  it('includes boxes inside the viewport at identity transform', () => {
    const ids = visibleBoxIds(
      [
        { id: 'inside', x: 100, y: 100, w: 100, h: 80 },
        { id: 'outside-right', x: 5000, y: 100, w: 100, h: 80 },
      ],
      { x: 0, y: 0, scale: 1 },
      size,
    );
    expect(ids.has('inside')).toBe(true);
    expect(ids.has('outside-right')).toBe(false);
  });

  it('honours the pan offset', () => {
    // View is panned so world (4900..5100, 100..180) is on screen.
    const ids = visibleBoxIds(
      [
        { id: 'far', x: 5000, y: 100, w: 100, h: 80 },
        { id: 'origin', x: 100, y: 100, w: 100, h: 80 },
      ],
      { x: -4950, y: -50, scale: 1 },
      size,
    );
    expect(ids.has('far')).toBe(true);
    expect(ids.has('origin')).toBe(false);
  });

  it('honours the zoom: far-away boxes leave the visible rect as you zoom in', () => {
    // At scale 1 the visible rect (plus 200 margin) reaches to x=1200; at scale 2 only to
    // x=700. So a box at x=1050 is culled by zooming in.
    const boxes = [
      { id: 'near', x: 100, y: 100, w: 100, h: 80 },
      { id: 'far', x: 1050, y: 100, w: 100, h: 80 },
    ];
    const zoomedOut = visibleBoxIds(boxes, { x: 0, y: 0, scale: 1 }, size);
    const zoomedIn = visibleBoxIds(boxes, { x: 0, y: 0, scale: 2 }, size);
    expect(zoomedOut.has('far')).toBe(true);
    expect(zoomedIn.has('far')).toBe(false);
  });

  it('keeps boxes within the margin, not beyond it', () => {
    // Right edge of the visible world rect is at x=1000; margin 200 covers to 1200.
    const ids = visibleBoxIds(
      [
        { id: 'in-margin', x: 1050, y: 100, w: 100, h: 80 },
        { id: 'beyond-margin', x: 1400, y: 100, w: 100, h: 80 },
      ],
      { x: 0, y: 0, scale: 1 },
      size,
    );
    expect(ids.has('in-margin')).toBe(true);
    expect(ids.has('beyond-margin')).toBe(false);
  });

  it('culls nothing while the viewport is unmeasured (size zero)', () => {
    const ids = visibleBoxIds(
      [
        { id: 'a', x: 100, y: 100, w: 100, h: 80 },
        { id: 'b', x: 9000, y: 9000, w: 100, h: 80 },
      ],
      { x: 0, y: 0, scale: 1 },
      { w: 0, h: 0 },
    );
    expect(ids.size).toBe(2);
  });
});
