// Incremental reader for the convo model's ONE-JSON-envelope reply, fed raw text deltas as they
// arrive off the wire. It exists so a later task can send Irises's first sentence the moment it's
// readable instead of waiting for the whole envelope (confidence_level, tool_calls, bubbles,
// status) to finish generating — that wait is most of the latency this project is cutting.
//
// It is deliberately NOT a general JSON parser: it's a small hand-written character state machine
// that only understands the envelope's fixed top-level shape. The envelope's property order
// (bubbleJson.ts ~175-178 — confidence_level, tool_calls, bubbles, status, chosen so a
// max_tokens truncation keeps the tool call over the bubbles) is exactly what lets this reader stay
// dumb: `tool_calls` is guaranteed to close before `bubbles` opens, so `onToolCalls` always fires
// before the first `onSentence`, with no lookahead or buffering of the whole reply required.
//
// A stack of frames tracks nesting. Only two frame kinds ever need to know their current key ("top"
// and "bubble object") — every other nested value (tool_calls' array contents, status, a bubble's
// `re`) is opaque: the reader tracks just enough (string/escape state, brace/bracket depth) to skip
// it correctly, including a `"text"` key that shows up somewhere it doesn't matter (tool args,
// status) — those never reach a frame that treats `text` specially, so they're never emitted.

export interface EnvelopeStreamEvents {
  /** Fired once, when the `tool_calls` value has closed. `empty` = null or []. */
  onToolCalls?(empty: boolean): void;
  /** A finished sentence inside bubbles[bubble].text — at a sentence end (. ! ? … followed by
   * space), a decoded newline, or the bubble string closing. Unescaped, trimmed, never empty. */
  onSentence?(bubble: number, text: string): void;
  /** bubbles[bubble] string closed (fires after its last onSentence). */
  onBubbleEnd?(bubble: number): void;
}

type ObjectPhase = 'beforeKey' | 'afterKey' | 'beforeValue' | 'afterValue';

// The only two frame kinds that read their own keys. `key` drives what a value means: on `top`,
// whether beforeValue means "watch for tool_calls/bubbles"; on `bubbleObject`, whether the string
// about to open is the one sentences come out of.
interface KeyedFrame {
  kind: 'top' | 'bubbleObject';
  phase: ObjectPhase;
  key: string;
  index: number; // bubble index; unused (and meaningless) on 'top'
}

// Everything else is opaque nesting the reader only needs to skip correctly:
//  - bubblesArray: spawns a bubbleObject on each `{` directly inside it.
//  - toolCallsRoot: the `tool_calls` array itself — tracks whether it ever held an element, so its
//    close can report `empty`.
//  - generic: any other object/array (tool_calls' inner objects, status, a bubble's `re`, …) — its
//    contents are never inspected, just balanced.
type Frame = KeyedFrame | { kind: 'bubblesArray' } | { kind: 'toolCallsRoot'; sawContent: boolean } | { kind: 'generic' };

function isBoundaryPunct(c: string): boolean {
  return c === '.' || c === '!' || c === '?' || c === '…';
}

export function createEnvelopeStream(ev: EnvelopeStreamEvents): { push(delta: string): void; end(): void } {
  const stack: Frame[] = [];
  let started = false; // have we seen the envelope's opening `{` yet
  let done = false; // the top-level object has closed; ignore anything after
  let nextBubbleIndex = 0;

  // String-scanning state. Applies whenever `inString` is true, regardless of which frame is open —
  // a `{` or `"` inside a string never affects nesting, so this lives outside the frame stack.
  let inString = false;
  let escaping = false;
  let collectingUnicode = false;
  let unicodeDigits = '';

  // What the string currently open is FOR, decided at the quote that opened it:
  //  - 'key': accumulate into keyBuf, to name the owning frame's next key.
  //  - 'text': feed decoded chars to the sentence detector for the open bubble.
  //  - null: content doesn't matter (a `re` value, anything inside a generic frame, …) — discard it.
  let stringRole: 'key' | 'text' | null = null;
  let keyBuf = '';

  // A bare (non-string, non-container) value — a number, `true`, `false`, or `null` — being
  // consumed one char at a time until a delimiter shows it's finished. The only bare value this
  // reader cares about is `tool_calls: null`; everything else (confidence_level, a stray bare
  // status field) is skipped the same way.
  let inScalar = false;

  let sentenceBuf = '';

  function topFrame(): Frame | undefined {
    return stack[stack.length - 1];
  }

  function emitSentence(bubbleIndex: number): void {
    const text = sentenceBuf.trim();
    sentenceBuf = '';
    if (text) ev.onSentence?.(bubbleIndex, text);
  }

  function feedTextChar(bubbleIndex: number, c: string): void {
    if (c === '\n') {
      emitSentence(bubbleIndex);
      return;
    }
    const prev = sentenceBuf[sentenceBuf.length - 1] ?? '';
    // A boundary only fires once punctuation is actually FOLLOWED by whitespace — which is why
    // "3.5" and a bare URL never split: the char after their `.` is a digit or letter, not space,
    // so this branch simply never triggers for them. No digit/URL special-casing needed.
    if (/\s/.test(c) && isBoundaryPunct(prev)) {
      emitSentence(bubbleIndex);
      return; // the whitespace itself is the delimiter — don't carry it into the next sentence
    }
    sentenceBuf += c;
  }

  function appendDecoded(c: string): void {
    if (stringRole === 'key') {
      keyBuf += c;
      return;
    }
    if (stringRole === 'text') {
      const f = topFrame();
      if (f && f.kind === 'bubbleObject') feedTextChar(f.index, c);
      return;
    }
    // discard
  }

  // After a value resolves (a string closes, a scalar hits its delimiter, or a child frame pops),
  // the owning keyed frame moves from "reading a value" to "reading a comma or the close brace" —
  // but only if it was actually mid-value; a pop whose parent isn't waiting on it (e.g. bubblesArray
  // after a bubbleObject closes) is a no-op.
  function markValueResolved(): void {
    const f = topFrame();
    if (f && (f.kind === 'top' || f.kind === 'bubbleObject') && f.phase === 'beforeValue') {
      f.phase = 'afterValue';
    }
  }

  function popFrame(): void {
    const f = stack.pop();
    if (!f) return;
    if (f.kind === 'bubbleObject') ev.onBubbleEnd?.(f.index);
    if (f.kind === 'toolCallsRoot') ev.onToolCalls?.(!f.sawContent);
    if (f.kind === 'top') done = true;
    markValueResolved();
  }

  function closeString(): void {
    inString = false;
    const wasRole = stringRole;
    const frame = topFrame();
    if (wasRole === 'text' && frame && frame.kind === 'bubbleObject') {
      emitSentence(frame.index); // the string's end is itself a sentence boundary
    }
    stringRole = null;
    if (frame && (frame.kind === 'top' || frame.kind === 'bubbleObject')) {
      if (wasRole === 'key') {
        frame.key = keyBuf;
        frame.phase = 'afterKey';
      } else {
        frame.phase = 'afterValue';
      }
    }
  }

  function handleStringChar(raw: string): void {
    if (collectingUnicode) {
      unicodeDigits += raw;
      if (unicodeDigits.length === 4) {
        const code = parseInt(unicodeDigits, 16);
        collectingUnicode = false;
        unicodeDigits = '';
        appendDecoded(String.fromCharCode(code));
      }
      return;
    }
    if (escaping) {
      escaping = false;
      switch (raw) {
        case 'n': appendDecoded('\n'); return;
        case 't': appendDecoded('\t'); return;
        case 'r': appendDecoded('\r'); return;
        case 'b': appendDecoded('\b'); return;
        case 'f': appendDecoded('\f'); return;
        case '"': appendDecoded('"'); return;
        case '\\': appendDecoded('\\'); return;
        case '/': appendDecoded('/'); return;
        case 'u': collectingUnicode = true; unicodeDigits = ''; return;
        default: appendDecoded(raw); return; // unknown escape: best-effort passthrough
      }
    }
    if (raw === '\\') { escaping = true; return; }
    if (raw === '"') { closeString(); return; }
    appendDecoded(raw);
  }

  function openString(frame: Frame | undefined): void {
    inString = true;
    if (frame && (frame.kind === 'top' || frame.kind === 'bubbleObject') && frame.phase === 'beforeKey') {
      stringRole = 'key';
      keyBuf = '';
    } else if (frame && frame.kind === 'bubbleObject' && frame.phase === 'beforeValue' && frame.key === 'text') {
      stringRole = 'text';
      sentenceBuf = '';
    } else {
      stringRole = null;
    }
  }

  function handleKeyedFrameChar(frame: KeyedFrame, c: string): void {
    switch (frame.phase) {
      case 'beforeKey':
        if (/\s/.test(c)) return;
        if (c === '"') { openString(frame); return; }
        if (c === '}') { popFrame(); return; }
        return; // stray comma before a key — ignore
      case 'afterKey':
        if (/\s/.test(c)) return;
        if (c === ':') { frame.phase = 'beforeValue'; return; }
        return;
      case 'beforeValue':
        if (/\s/.test(c)) return;
        if (c === '"') { openString(frame); return; }
        if (c === '[') {
          if (frame.kind === 'top' && frame.key === 'bubbles') stack.push({ kind: 'bubblesArray' });
          else if (frame.kind === 'top' && frame.key === 'tool_calls') stack.push({ kind: 'toolCallsRoot', sawContent: false });
          else stack.push({ kind: 'generic' });
          return;
        }
        if (c === '{') { stack.push({ kind: 'generic' }); return; }
        // A bare value (number / true / false / null) starts here — including tool_calls: null.
        inScalar = true;
        return;
      case 'afterValue':
        if (/\s/.test(c)) return;
        if (c === ',') { frame.phase = 'beforeKey'; return; }
        if (c === '}') { popFrame(); return; }
        return;
    }
  }

  function handleBubblesArrayChar(c: string): void {
    if (/\s/.test(c)) return;
    if (c === '{') {
      stack.push({ kind: 'bubbleObject', phase: 'beforeKey', key: '', index: nextBubbleIndex++ });
      return;
    }
    if (c === ']') { popFrame(); return; }
    // commas between elements — nothing to do
  }

  function handleToolCallsRootChar(frame: { kind: 'toolCallsRoot'; sawContent: boolean }, c: string): void {
    if (/\s/.test(c)) return;
    if (c === ']') { popFrame(); return; }
    frame.sawContent = true; // anything but whitespace or the close means a non-empty array
    if (c === '"') { openString(frame); return; }
    if (c === '{' || c === '[') { stack.push({ kind: 'generic' }); return; }
    // a comma, or a stray bare token — irrelevant, skip
  }

  function handleGenericChar(c: string): void {
    if (c === '"') { openString(undefined); return; }
    if (c === '{' || c === '[') { stack.push({ kind: 'generic' }); return; }
    if (c === '}' || c === ']') { popFrame(); return; }
    // colons, commas, bare-value characters — opaque here, skip
  }

  function processChar(c: string): void {
    if (done) return;

    if (inString) { handleStringChar(c); return; }

    if (inScalar) {
      // A delimiter ends the bare value; reprocess it normally (it's almost always the `,` or `}`
      // that the owning frame needs to see to advance).
      if (c === ',' || c === '}' || c === ']' || c === '"' || /\s/.test(c)) {
        inScalar = false;
        const f = topFrame();
        // tool_calls' only legal bare value is `null` — its resolution IS the empty report.
        if (f && f.kind === 'top' && f.key === 'tool_calls') ev.onToolCalls?.(true);
        markValueResolved();
        processChar(c);
        return;
      }
      return; // mid-token (a digit, or a letter of true/false/null) — just consume it
    }

    if (!started) {
      if (/\s/.test(c)) return;
      if (c === '{') { started = true; stack.push({ kind: 'top', phase: 'beforeKey', key: '', index: -1 }); }
      return;
    }

    const frame = topFrame();
    if (!frame) return;

    switch (frame.kind) {
      case 'top':
      case 'bubbleObject':
        handleKeyedFrameChar(frame, c);
        return;
      case 'bubblesArray':
        handleBubblesArrayChar(c);
        return;
      case 'toolCallsRoot':
        handleToolCallsRootChar(frame, c);
        return;
      case 'generic':
        handleGenericChar(c);
        return;
    }
  }

  return {
    push(delta: string): void {
      for (let i = 0; i < delta.length; i++) processChar(delta[i]);
    },
    end(): void {
      // Nothing left open gets emitted: an unterminated string's partial sentence buffer and any
      // frame still on the stack are simply dropped. The model never finished them, so relaying
      // them would show Irises text she never actually said.
    },
  };
}
