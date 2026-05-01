// Reconstructs Anthropic SSE content blocks into typed AssistantBlock[].
// Three load-bearing constraints:
//  - Signature_delta strings concatenate raw (base64-ASCII, must round-trip
//    byte-identical for replay verification).
//  - Drop unpaired tool_use / tool_result blocks; orphans 400 on replay.
//  - Surface partial text/thinking on mid-stream kill so users see what
//    they saw streamed.
import { assertNeverBlock, type AssistantBlock } from '../../shared/chat-blocks';
import type { StreamingBlock } from '../../shared/streaming-blocks';

export interface RawSseEvent {
  type: string;
  index?: number;
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
}

export class StreamBlockAccumulator {
  // Block content keyed by SSE `index`; numerically sorted on emit (indices
  // need not arrive in order).
  private readonly blocks = new Map<number, StreamingBlock>();
  // Per-instance one-shot warning gates so a stream that emits 50 unknown
  // blocks of the same type only logs once rather than spamming devtools.
  private readonly warnedUnknownTypes = new Set<string>();
  // Indices we dropped at content_block_start (unknown block type). Tracked
  // so the matching content_block_stop / content_block_delta don't trigger a
  // separate "orphan" warn — we already surfaced the drop at start.
  private readonly droppedIndices = new Set<number>();
  // Orphan deltas/stops mean an SSE event arrived for an index we never saw
  // a content_block_start for. One warn per stream per kind so a fully torn
  // stream (e.g. a mid-flight reconnect that loses many start frames)
  // surfaces the silent-drop without flooding.
  private warnedOrphanDelta = false;
  private warnedOrphanStop = false;

  handleEvent(event: RawSseEvent): void {
    const idx = typeof event.index === 'number' ? event.index : -1;
    if (event.type === 'content_block_start') {
      const cb = event.content_block;
      if (idx < 0 || !cb || typeof cb !== 'object') return;
      const cbType = cb.type;
      if (cbType === 'text') {
        this.blocks.set(idx, { type: 'text', text: '' });
      } else if (cbType === 'thinking') {
        this.blocks.set(idx, { type: 'thinking', thinking: '', signature: '' });
      } else if (cbType === 'server_tool_use') {
        const id = typeof cb.id === 'string' ? cb.id : '';
        const name = typeof cb.name === 'string' ? cb.name : '';
        this.blocks.set(idx, {
          type: 'server_tool_use',
          id,
          name,
          input_json_raw: '',
          input: null,
        });
      } else if (cbType === 'web_search_tool_result') {
        const tool_use_id = typeof cb.tool_use_id === 'string' ? cb.tool_use_id : '';
        // tool_result blocks deliver their full content on block_start
        // (they're synthesized server-side once Anthropic resolves the tool
        // call); there are no deltas to accumulate.
        this.blocks.set(idx, {
          type: 'web_search_tool_result',
          tool_use_id,
          content: cb.content,
        });
      } else if (cbType === 'code_execution_tool_result') {
        const tool_use_id = typeof cb.tool_use_id === 'string' ? cb.tool_use_id : '';
        this.blocks.set(idx, {
          type: 'code_execution_tool_result',
          tool_use_id,
          content: cb.content,
        });
      } else {
        // Unknown block type. Best-effort: drop and warn (once per type per
        // session) so a future Anthropic block kind we don't model surfaces
        // in devtools instead of disappearing silently. Remember the index
        // so its later delta/stop events don't double-warn as orphans.
        this.droppedIndices.add(idx);
        const typeKey = typeof cbType === 'string' ? cbType : `<${typeof cbType}>`;
        if (!this.warnedUnknownTypes.has(typeKey)) {
          this.warnedUnknownTypes.add(typeKey);
          console.warn('[streamBlockAccumulator] unknown content block type; ignoring', {
            type: typeKey,
          });
        }
      }
      return;
    }

    if (event.type === 'content_block_delta') {
      const d = event.delta;
      if (idx < 0 || !d || typeof d !== 'object') return;
      const existing = this.blocks.get(idx);
      if (!existing) {
        // Suppress orphan warn for indices we dropped at start (unknown
        // block type already warned there) — only surface the truly
        // unexpected case where no start was ever seen.
        if (!this.droppedIndices.has(idx) && !this.warnedOrphanDelta) {
          this.warnedOrphanDelta = true;
          console.warn(
            `[StreamBlockAccumulator] orphan delta at index ${idx} — likely SSE-stream split`,
          );
        }
        return;
      }
      const dtype = d.type;
      if (dtype === 'text_delta' && existing.type === 'text' && typeof d.text === 'string') {
        existing.text += d.text;
      } else if (
        dtype === 'thinking_delta' &&
        existing.type === 'thinking' &&
        typeof d.thinking === 'string'
      ) {
        existing.thinking += d.thinking;
      } else if (
        dtype === 'signature_delta' &&
        existing.type === 'thinking' &&
        typeof d.signature === 'string'
      ) {
        // Concatenate raw — Anthropic signatures are base64-ASCII and must
        // round-trip byte-identical for replay verification.
        existing.signature += d.signature;
      } else if (
        dtype === 'input_json_delta' &&
        existing.type === 'server_tool_use' &&
        typeof d.partial_json === 'string'
      ) {
        existing.input_json_raw += d.partial_json;
      }
      return;
    }

    if (event.type === 'content_block_stop') {
      if (idx < 0) return;
      const existing = this.blocks.get(idx);
      if (!existing) {
        // Suppress orphan warn for indices we dropped at start (unknown
        // block type already warned there) — only surface the truly
        // unexpected case where no start was ever seen.
        if (!this.droppedIndices.has(idx) && !this.warnedOrphanStop) {
          this.warnedOrphanStop = true;
          console.warn(
            `[StreamBlockAccumulator] orphan stop at index ${idx} — likely SSE-stream split`,
          );
        }
        return;
      }
      if (existing.type === 'server_tool_use' && existing.input === null) {
        // Parse accumulated partial_json into a concrete object. Empty raw
        // → {} (some tools take no input). Malformed → leave input null;
        // toAssistantContentBlocks will drop the block before emit.
        const raw = existing.input_json_raw;
        try {
          const parsed = JSON.parse(raw.length === 0 ? '{}' : raw) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            existing.input = parsed as Record<string, unknown>;
          }
        } catch (e) {
          // Malformed JSON: input stays null; emit-time drop. Warn so the
          // dropped tool block (and its now-orphaned tool_result) doesn't
          // disappear from history without a trace.
          console.warn(
            '[streamBlockAccumulator] failed to parse server_tool_use input_json; block will drop on emit',
            { idx, partial: existing.input_json_raw.slice(0, 200), error: String(e) },
          );
        }
      }
      return;
    }
  }

  _entries(): Array<[number, StreamingBlock]> {
    return Array.from(this.blocks.entries());
  }
}

/**
 * Convert the accumulator's internal state into the typed AssistantBlock[]
 * we ship to localStorage and back to Anthropic on the next turn.
 *
 * Drops:
 *  - server_tool_use with malformed input (input still null after stop).
 *  - server_tool_use with no matching tool_result (orphans 400 on replay).
 *  - tool_result with no matching server_tool_use (defensive symmetry).
 *
 * Surfaces partial text/thinking blocks even without block_stop so a kill
 * mid-text leaves the user with what they saw streamed.
 */
export function toAssistantContentBlocks(acc: StreamBlockAccumulator): AssistantBlock[] {
  const sorted = acc._entries().sort(([a], [b]) => a - b);

  // First pass: identify which server_tool_use ids have matching results
  // and vice versa. Only paired tool blocks survive into the emitted output.
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const [, block] of sorted) {
    switch (block.type) {
      case 'text':
      case 'thinking':
        // Not a tool block; nothing to pair.
        break;
      case 'server_tool_use':
        if (block.input !== null) toolUseIds.add(block.id);
        break;
      case 'web_search_tool_result':
      case 'code_execution_tool_result':
        toolResultIds.add(block.tool_use_id);
        break;
      default:
        // Exhaustiveness: any new StreamingBlock variant must opt in here.
        assertNeverBlock(block);
    }
  }

  const out: AssistantBlock[] = [];
  for (const [, block] of sorted) {
    switch (block.type) {
      case 'text':
        // Skip empty text blocks — Anthropic rejects empty text content on replay.
        if (block.text.length > 0) {
          out.push({ type: 'text', text: block.text });
        }
        break;
      case 'thinking':
        // Skip empty thinking — same reasoning.
        if (block.thinking.length > 0 || block.signature.length > 0) {
          out.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
        }
        break;
      case 'server_tool_use':
        // Drop if input still null (malformed JSON) OR if no paired result.
        if (block.input === null) break;
        if (!toolResultIds.has(block.id)) break;
        out.push({
          type: 'server_tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;
      case 'web_search_tool_result':
        // Drop if no matching server_tool_use (orphan).
        if (!toolUseIds.has(block.tool_use_id)) break;
        out.push({
          type: 'web_search_tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
        });
        break;
      case 'code_execution_tool_result':
        if (!toolUseIds.has(block.tool_use_id)) break;
        out.push({
          type: 'code_execution_tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
        });
        break;
      default:
        // Exhaustiveness: any new StreamingBlock variant must opt in here.
        assertNeverBlock(block);
    }
  }
  return out;
}
