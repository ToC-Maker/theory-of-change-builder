// `computeMakeRoom` decides how the nodes of a column shift when a dragged
// node lands in it, so the landing box never overlaps a neighbour. It is
// the single source for both the live drag preview and the drop commit.
//
// Conventions in these tests: a node is `{ id, centerY, height }` in
// column-local px, so its box spans `centerY ± height/2`; every node is
// 76px tall unless a test says otherwise, and the gap is 16px.
import { describe, it, expect } from 'vitest';
import {
  computeMakeRoom,
  planColumnDrop,
  MAKE_ROOM_GAP_PX,
  type MakeRoomNode,
  type MakeRoomResult,
} from '../../src/utils/makeRoom';
import type { Node } from '../../src/types';

const H = 76;
const n = (id: string, centerY: number, height = H): MakeRoomNode => ({ id, centerY, height });

// `shifted` is a Map keyed by node id; the assertions read it as a plain object.
const plain = ({ droppedCenterY, shifted }: MakeRoomResult) => ({
  droppedCenterY,
  shifted: Object.fromEntries(shifted),
});

const room = (droppedCenterY: number, nodes: MakeRoomNode[], droppedHeight = H) =>
  plain(computeMakeRoom({ droppedCenterY, droppedHeight, nodes }));

describe('computeMakeRoom', () => {
  it('uses a 16px minimum gap by default', () => {
    expect(MAKE_ROOM_GAP_PX).toBe(16);
  });

  it('moves nothing when no node is within the gap of the landing box', () => {
    // Landing box 262..338; neighbours end at 138 and start at 462.
    expect(room(300, [n('a', 100), n('b', 500)])).toEqual({ droppedCenterY: 300, shifted: {} });
  });

  it('moves nothing for an empty column', () => {
    expect(room(300, [])).toEqual({ droppedCenterY: 300, shifted: {} });
  });

  it('leaves a node that sits exactly one gap away, and moves one that is a pixel closer', () => {
    // Landing bottom 338 + gap 16 = 354: a node whose top is 354 has centre 392.
    expect(room(300, [n('b', 392)]).shifted).toEqual({});
    expect(room(300, [n('b', 391)]).shifted).toEqual({ b: 392 });
  });

  it('pushes overlapping nodes below down by just enough to leave the gap', () => {
    // Landing box 262..338. 'a' (292..368) → top 354, centre 392.
    expect(room(300, [n('a', 330)])).toEqual({ droppedCenterY: 300, shifted: { a: 392 } });
  });

  it('cascades downward: each lower node moves only if the one above now overlaps it', () => {
    const result = room(300, [n('a', 330), n('b', 420), n('c', 600)]);
    // a: 292..368 → top 354 → centre 392 (bottom 430).
    // b: 382..458 sits inside a's new gap zone (floor 446) → top 446 → centre 484.
    // c: top 562 ≥ 484 + 38 + 16 = 538 → untouched.
    expect(result.shifted).toEqual({ a: 392, b: 484 });
    expect(result.droppedCenterY).toBe(300);
  });

  it('pushes overlapping nodes above up, cascading upward', () => {
    // Landing box 462..538 (centre 500); the nodes above it end further up.
    const result = room(500, [n('a', 470), n('b', 400), n('c', 100)]);
    // a: 432..508 → bottom 446 → centre 408; b: 362..438 → bottom 354 → centre 316;
    // c: bottom 138 ≤ b's new top 278 - 16 → untouched.
    expect(result.shifted).toEqual({ a: 408, b: 316 });
    expect(result.droppedCenterY).toBe(500);
  });

  it('moves nodes above and below independently', () => {
    const result = room(500, [n('up', 480), n('down', 520), n('far', 900)]);
    expect(result.shifted).toEqual({ up: 408, down: 592 });
  });

  it('keeps the vertical order of the nodes it moves', () => {
    const result = room(300, [n('a', 305), n('b', 310), n('c', 315)]);
    const ys = ['a', 'b', 'c'].map((id) => result.shifted[id]);
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
  });

  it('does not depend on the order the nodes are listed in', () => {
    const nodes = [n('c', 600), n('a', 330), n('b', 420)];
    expect(room(300, nodes)).toEqual(room(300, [...nodes].reverse()));
    expect(room(300, nodes).shifted).toEqual({ a: 392, b: 484 });
  });

  it('measures the gap from the real box edges of nodes of different heights', () => {
    // Dropped 100 tall (250..350). Tall node below: centre 340, 200 tall → top 240.
    // Needs top 366 → centre 466.
    const result = room(300, [n('tall', 340, 200)], 100);
    expect(result.shifted).toEqual({ tall: 466 });
  });

  it('treats a node centred exactly on the landing centre as below it', () => {
    expect(room(300, [n('same', 300)]).shifted).toEqual({ same: 300 + H + MAKE_ROOM_GAP_PX });
  });

  describe('blocked at the top of the column', () => {
    it('moves the dropped node down until the nodes above can move up and fit', () => {
      // Landing box 62..138. 'a' (12..88) would need bottom 46 → centre 8,
      // top -30: past the column top, so the dropped node drops by 30.
      // New landing centre 130: 'a' → bottom 76 → centre 38 (top 0).
      expect(room(100, [n('a', 50)])).toEqual({ droppedCenterY: 130, shifted: { a: 38 } });
    });

    it('continues the downward cascade from the pushed landing spot', () => {
      // Same as above, plus 'b' (122..198) below: landing box is now
      // 92..168 → 'b' top must be 184 → centre 222.
      expect(room(100, [n('a', 50), n('b', 160)])).toEqual({
        droppedCenterY: 130,
        shifted: { a: 38, b: 222 },
      });
    });

    it('accounts for a whole stack of nodes above that cannot all move up', () => {
      // Landing box 132..208 (centre 170); 'b' (112..188) and 'a' (20..96) above it.
      // Packed against the column top 'a' ends at 0..76, 'b' at 92..168, so the
      // landing top must clear 168 + 16 → centre 222.
      expect(room(170, [n('a', 58), n('b', 150)])).toEqual({
        droppedCenterY: 222,
        shifted: { b: 130, a: 38 },
      });
    });

    it('only pushes the dropped node down as far as the nodes above need', () => {
      // 'a' already touches the column top, so 'b' (92..168) cannot move
      // either: the landing box just clears it, 168 + 16 above its top.
      expect(room(150, [n('a', 38), n('b', 130)])).toEqual({ droppedCenterY: 222, shifted: {} });
    });

    it('does not push the dropped node when a node at the column top already clears it', () => {
      expect(room(200, [n('a', 38)])).toEqual({ droppedCenterY: 200, shifted: {} });
    });
  });

  describe('whole pixels', () => {
    it('rounds a fractional landing centre', () => {
      expect(room(300.4, [])).toEqual({ droppedCenterY: 300, shifted: {} });
      expect(room(300.6, [])).toEqual({ droppedCenterY: 301, shifted: {} });
    });

    it('moves nodes to whole-pixel centres, away from the landing box, so the gap never shrinks', () => {
      // Landing 301 (box 263..339). Below: a 75px node → exact centre 392.5,
      // rounded away from the landing box to 393 (top 355.5, gap 16.5).
      expect(room(300.6, [n('below', 330, 75)]).shifted).toEqual({ below: 393 });
      // Above: bottom must be 247 → exact centre 209.5, rounded away to 209.
      expect(room(300.6, [n('above', 290, 75)]).shifted).toEqual({ above: 209 });
    });

    it('holds the gap and whole pixels across a cascade of odd and even heights', () => {
      for (const landing of [150.3, 301.5, 420.9]) {
        const nodes = [n('a', 140, 75), n('b', 200, 77), n('c', 260, 76), n('d', 330, 75)];
        const result = computeMakeRoom({ droppedCenterY: landing, droppedHeight: 77, nodes });
        const boxes = [
          { top: result.droppedCenterY - 77 / 2, bottom: result.droppedCenterY + 77 / 2 },
          ...nodes.map((node) => {
            const c = result.shifted.get(node.id) ?? node.centerY;
            return { top: c - node.height / 2, bottom: c + node.height / 2 };
          }),
        ].sort((p, q) => p.top - q.top);
        expect(Number.isInteger(result.droppedCenterY)).toBe(true);
        for (const c of result.shifted.values()) expect(Number.isInteger(c)).toBe(true);
        for (let i = 1; i < boxes.length; i++) {
          expect(boxes[i].top - boxes[i - 1].bottom).toBeGreaterThanOrEqual(MAKE_ROOM_GAP_PX);
        }
      }
    });

    it('keeps a rounded node inside the column top', () => {
      // A 75px node at the column top would exactly fit at centre 37.5; the
      // whole-pixel centre 37 would put its top at -0.5, so the landing goes
      // one px further down instead (130) and the node settles at 38 (top 0.5).
      const result = room(100, [n('a', 50, 75)]);
      expect(result.droppedCenterY).toBe(130);
      expect(result.shifted.a).toBe(38);
      expect(result.shifted.a - 75 / 2).toBeGreaterThanOrEqual(0);
    });
  });

  it('keys the shifts by id without touching Object.prototype names', () => {
    // A plain-object lookup of these ids would answer with inherited members.
    const { shifted } = computeMakeRoom({
      droppedCenterY: 300,
      droppedHeight: H,
      nodes: [n('constructor', 330), n('toString', 900)],
    });
    expect(shifted.get('constructor')).toBe(392);
    expect(shifted.get('toString')).toBeUndefined();
    expect(shifted.get('hasOwnProperty')).toBeUndefined();
  });

  it('leaves its input untouched', () => {
    const nodes = Object.freeze([Object.freeze(n('a', 330)), Object.freeze(n('b', 420))]);
    expect(() => room(300, nodes as MakeRoomNode[])).not.toThrow();
  });
});

describe('planColumnDrop', () => {
  const node = (id: string, yPosition?: number): Node => ({
    id,
    title: id,
    text: '',
    connectionIds: [],
    connections: [],
    yPosition,
  });

  const plan = (
    columnNodes: Node[],
    draggedId: string,
    landingCenterY: number,
    nodeHeights: Record<string, number> = {},
  ) =>
    plain(
      planColumnDrop({
        columnNodes,
        draggedId,
        draggedHeight: H,
        landingCenterY,
        nodeHeights,
      }),
    );

  it('excludes the dragged node: its own slot neither moves nor pushes anything', () => {
    // D sits at 300, E at 340. Dropping D at 320 (282..358): E (302..378) is
    // below it and moves; D's old slot must not push D itself.
    const result = plan([node('D', 300), node('E', 340)], 'D', 320);
    expect(result.shifted).toEqual({ E: 412 });
    expect(result.droppedCenterY).toBe(320);
  });

  it('reads each node at the centre it renders: clamped to the column top', () => {
    // 'a' has yPosition 10 → renders at centre 38 (top 0). Landing at 70
    // (32..108): 'a' (0..76) is above and would have to end at bottom 16,
    // past the column top, so the landing moves down by 60 to clear it.
    const result = plan([node('a', 10)], 'x', 70);
    expect(result).toEqual({ droppedCenterY: 130, shifted: {} });
  });

  it('reads nodes without a yPosition at the default stacked slot', () => {
    // Index 1 with no yPosition renders at top 1*180+30 = 210 → centre 248.
    // Landing at 248 collides with it: it is at the landing centre (below).
    const result = plan([node('first', 1000), node('second')], 'x', 248);
    expect(result.shifted).toEqual({ second: 248 + H + MAKE_ROOM_GAP_PX });
  });

  it('uses measured heights and falls back to 76', () => {
    const result = plan([node('tall', 340)], 'x', 300, { tall: 200 });
    // Landing 262..338; tall (240..440) → top 354 → centre 454.
    expect(result.shifted).toEqual({ tall: 454 });
  });
});
