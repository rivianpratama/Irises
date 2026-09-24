// Incremental reader for the convo model's ONE-JSON-envelope reply, fed raw text deltas as they
// arrive off the wire. It exists so a later task can send Irises's first sentence the moment it's
// readable instead of waiting for the whole envelope (confidence_level, tool_calls, bubbles,
// status) to finish generating — that wait is most of the latency this project is cutting.
//
// It is deliberately NOT a general JSON parser: it's a small hand-written character state machine
// that only understands the envelope's fixed top-level shape. The envelope's property order
// (bubbleJson.ts ~175-178 — confidence_level, tool_calls, bubbles, status, chosen so a
// max_tokens truncation keeps the tool call over the bubbles) is exactly what USUALLY lets
// `tool_calls` close before `bubbles` opens. This reader doesn't trust that, though: every sentence
// it emits gets sent to a real person immediately, so `onToolCalls` fails CLOSED — it reports
// `empty: false` (assume there's a tool call, don't let a bubble speak over it) for anything short
// of a confirmed `null`/`[]`, and it fires that verdict the moment `bubbles` opens even if
// `tool_calls` hasn't resolved yet, rather than trusting the model got the order right.
//
// A stack of frames tracks nesting. Only two frame kinds ever need to know their current key ("top"
// and "bubble object") — every other nested value (tool_calls' array contents, status, a bubble's
// `re`) is opaque: the reader tracks just enough (string/escape state, brace/bracket depth) to skip
// it correctly, including a `"text"` key that shows up somewhere it doesn't matter (tool args,
// status) — those never reach a frame that treats `text` specially, so they're never emitted.
//
// Sentence-splitting is deliberately conservative: a missed split just delays text inside a bubble
// (still safe), but a WRONG split sends a fragment as if it were the whole thought. So `.`/`!`/`?`
// followed by whitespace only counts as a boundary when it isn't an initialism (a.m., i.e., u.s.),
// a short title (Mr., Dr., St.), or a list marker (`1.`) — and `...`/`…` never splits at all, since
// in her texting an ellipsis is a trailing-off mid-thought, not a full stop. An emoji run (plus
// variation selectors/ZWJ) right after a boundary stays glued to the sentence before it, so
// "done. 😀 next" reads as "done. 😀" / "next", not a bubble that's just an emoji.

export interface EnvelopeStreamEvents {
  /** Fired once, before the first onSentence. `empty` is true ONLY when `tool_calls` resolved to a
   * confirmed `null` or `[]`, and no other occurrence of the key said otherwise (duplicate keys are
   * sticky-false: once any occurrence is non-empty, later ones can't flip it back). A string, an
   * object, any other bare value, a `tool_calls` key that never showed up before `bubbles` opened —
   * all of those report `false`. Uncertain reports as "not empty" because the cost of wrongly
   * speaking over a real tool call is worse than a false alarm. */
  onToolCalls?(empty: boolean): void;
  /** A finished sentence inside a bubble's text — at a sentence end (`.`/`!`/`?` followed by
   * whitespace, excluding an abbreviation/title/list-marker tail and excluding `...`/`…`), a
   * decoded newline, or the string closing. An emoji-only run right after a boundary is kept with
   * the sentence it follows rather than starting a new one. Unescaped, trimmed, never empty. */
  onSentence?(bubble: number, text: string): void;
  /** A bubble's text string closed (fires right after its last onSentence — for an object bubble
   * this can be well before the object itself closes, e.g. while `re` is still being read). */
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

// Everything else is opaque nesting the reader only needs to skip correctly, plus two special
// cases:
//  - bubblesArray: spawns a bubbleObject on each `{` directly inside it, or a bareBubble on each
//    `"` directly inside it — the model is allowed to reply with a bare string instead of
//    `{"text": ...}`.
//  - bareBubble: a bubble whose whole value IS its text string (no wrapping object, so no `re`).
//  - toolCallsRoot: the `tool_calls` array itself — tracks whether it ever held an element, so its
//    close can report whether it was empty.
//  - generic: any other object/array (tool_calls' inner objects, status, a bubble's `re`, a
//    non-array/non-null tool_calls value's own nesting, …) — its contents are never inspected, just
//    balanced.
type Frame =
  | KeyedFrame
  | { kind: 'bubblesArray' }
  | { kind: 'bareBubble'; index: number }
  | { kind: 'toolCallsRoot'; sawContent: boolean }
  | { kind: 'generic' };

function isBoundaryPunct(c: string): boolean {
  return c === '.' || c === '!' || c === '?'; // NOT '…' — an ellipsis never ends a sentence here
}

// Abbreviation / title / list-marker tails that keep a trailing `.` glued to what follows, checked
// against the sentence buffer (which already ends with that `.`). Only `.` gets these exceptions —
// `!`/`?` never do, and a run of 3+ literal dots (or the single `…` glyph) is handled separately
// as "not a boundary at all", not as an exception list.
const INITIALISM = /(?:^|\s)(?:[a-z]\.)+$/i; // a.m., i.e., u.s., e.g.
const SHORT_TITLE = /(?:^|\s)(?:mr|mrs|ms|dr|st|vs)\.$/i;
const LIST_MARKER = /(?:^|\n)\s*\d{1,2}\.$/; // "1." "12." at the start of the sentence/line

function noSplitAfterPeriod(buf: string): boolean {
  return /\.\.\.+$/.test(buf) || INITIALISM.test(buf) || SHORT_TITLE.test(buf) || LIST_MARKER.test(buf);
}

// Extended_Pictographic covers the emoji block; U+FE0F (variation selector-16, forces the emoji
// presentation) and U+200D (ZWJ, joins emoji into one glyph like a family or a flag) ride along
// with it but aren't Extended_Pictographic themselves.
const EMOJI_UNIT = /^(?:\p{Extended_Pictographic}|[\u{FE0F}\u{200D}])$/u;

function isHighSurrogate(c: string): boolean {
  const code = c.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff;
}

export function createEnvelopeStream(ev: EnvelopeStreamEvents): { push(delta: string): void; end(): void } {
  const stack: Frame[] = [];
  let started = false; // have we seen the envelope's opening `{` yet
  let done = false; // the top-level object has closed; ignore anything after
  let ended = false; // end() was called; push() is now a no-op, forever
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
  // consumed one char at a time until a delimiter shows it's finished. `scalarBuf` captures the
  // literal so tool_calls can tell an actual `null` apart from any other bare value (which fails
  // closed as non-empty).
  let inScalar = false;
  let scalarBuf = '';

  // tool_calls' resolution: undefined = never resolved. false is sticky — once any occurrence
  // (including a malformed duplicate key) resolves non-empty, a later "empty" resolution can't
  // undo it. The event itself only ever fires once, at fireToolCallsIfNeeded.
  let toolCallsKnownEmpty: boolean | undefined;
  let toolCallsFired = false;

  // The sentence text accumulated since the last emit/reset for whichever bubble is currently open.
  let sentenceBuf = '';

  // Emoji-lookahead state: once a real (non-suppressed) boundary is seen, the sentence isn't
  // emitted yet — we hold it in `pendingSentence` and start scanning `pendingRun` for an
  // all-emoji token that should stay glued to it (see EMOJI_UNIT). `pendingHigh` holds a lone
  // high surrogate until its pairing low surrogate arrives, possibly in the next push().
  let boundaryPending = false;
  let pendingSentence = '';
  let pendingRun = '';
  let pendingHigh = '';

  function topFrame(): Frame | undefined {
    return stack[stack.length - 1];
  }

  function resolveToolCalls(empty: boolean): void {
    if (!empty) { toolCallsKnownEmpty = false; return; } // sticky-false always wins
    if (toolCallsKnownEmpty !== false) toolCallsKnownEmpty = true;
  }

  function fireToolCallsIfNeeded(): void {
    if (toolCallsFired) return;
    toolCallsFired = true;
    ev.onToolCalls?.(toolCallsKnownEmpty === true);
  }

  function emitSentence(bubbleIndex: number): void {
    const text = sentenceBuf.trim();
    sentenceBuf = '';
    if (text) ev.onSentence?.(bubbleIndex, text);
  }

  // Resolve the pending emoji-lookahead: merge the accumulated run into the held sentence when it's
  // a non-empty (and by construction all-emoji) run, otherwise emit the sentence as it stood at the
  // boundary.
  function finishPendingBoundary(bubbleIndex: number, merge: boolean): void {
    const sentence = merge ? `${pendingSentence} ${pendingRun}` : pendingSentence;
    boundaryPending = false;
    pendingSentence = '';
    pendingRun = '';
    pendingHigh = '';
    const text = sentence.trim();
    if (text) ev.onSentence?.(bubbleIndex, text);
  }

  // What follows the boundary wasn't (only) emoji: emit the sentence as originally bounded, then
  // replay the accumulated run plus this character as ordinary content for the NEXT sentence.
  function abandonPendingBoundary(bubbleIndex: number, nextChar: string): void {
    const replay = pendingRun + nextChar;
    finishPendingBoundary(bubbleIndex, false);
    sentenceBuf = '';
    for (const ch of replay) feedTextChar(bubbleIndex, ch);
  }

  function handlePendingChar(bubbleIndex: number, c: string): void {
    if (pendingHigh) {
      const unit = pendingHigh + c;
      pendingHigh = '';
      if (EMOJI_UNIT.test(unit)) { pendingRun += unit; return; }
      abandonPendingBoundary(bubbleIndex, unit);
      return;
    }
    if (isHighSurrogate(c)) { pendingHigh = c; return; }
    if (c === '\n' || /\s/.test(c)) {
      // The token since the boundary ended: glue it on only if it was non-empty (and therefore,
      // by construction, all emoji — anything else would have aborted already).
      finishPendingBoundary(bubbleIndex, pendingRun.length > 0);
      return; // this whitespace/newline is consumed as the separator either way
    }
    if (EMOJI_UNIT.test(c)) { pendingRun += c; return; }
    abandonPendingBoundary(bubbleIndex, c);
  }

  // The string closed (or a bare bubble ended) while a boundary was still pending lookahead —
  // resolve it the same way a trailing whitespace/newline would (item 6 explicitly extends the
  // lookahead through end-of-string), then fall through to a normal flush if nothing was pending.
  function flushBubble(bubbleIndex: number): void {
    if (boundaryPending) { finishPendingBoundary(bubbleIndex, pendingRun.length > 0); return; }
    emitSentence(bubbleIndex);
  }

  function feedTextChar(bubbleIndex: number, c: string): void {
    if (boundaryPending) { handlePendingChar(bubbleIndex, c); return; }
    if (c === '\n') { emitSentence(bubbleIndex); return; }
    const prev = sentenceBuf[sentenceBuf.length - 1] ?? '';
    const isWs = /\s/.test(c);
    // A boundary only fires once punctuation is actually FOLLOWED by whitespace — which is why
    // "3.5" and a bare URL never split: the char after their `.` is a digit or letter, not space,
    // so this branch simply never triggers for them. No digit/URL special-casing needed.
    if (isWs && isBoundaryPunct(prev) && !(prev === '.' && noSplitAfterPeriod(sentenceBuf))) {
      // Don't emit yet — an emoji run right after this boundary stays glued to it (item 6).
      boundaryPending = true;
      pendingSentence = sentenceBuf;
      sentenceBuf = '';
      pendingRun = '';
      pendingHigh = '';
      return;
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
      if (f && (f.kind === 'bubbleObject' || f.kind === 'bareBubble')) feedTextChar(f.index, c);
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
    if (f.kind === 'toolCallsRoot') resolveToolCalls(!f.sawContent);
    if (f.kind === 'top') { fireToolCallsIfNeeded(); done = true; }
    markValueResolved();
  }

  function closeString(): void {
    inString = false;
    const wasRole = stringRole;
    const frame = topFrame();
    stringRole = null;

    if (frame && frame.kind === 'bareBubble') {
      if (wasRole === 'text') flushBubble(frame.index); // the string's end is itself a boundary
      stack.pop();
      ev.onBubbleEnd?.(frame.index);
      return;
    }

    if (frame && (frame.kind === 'top' || frame.kind === 'bubbleObject')) {
      if (wasRole === 'key') {
        frame.key = keyBuf;
        frame.phase = 'afterKey';
        return;
      }
      if (wasRole === 'text' && frame.kind === 'bubbleObject') {
        flushBubble(frame.index); // the string's end is itself a boundary
        ev.onBubbleEnd?.(frame.index); // fires here — the text string closing, not the object
      }
      frame.phase = 'afterValue';
    }
  }

  function handleStringChar(raw: string): void {
    if (collectingUnicode) {
      unicodeDigits += raw;
      if (unicodeDigits.length === 4) {
        const code = parseInt(unicodeDigits, 16);
        collectingUnicode = false;
        unicodeDigits = '';
        // An invalid \uXXXX (non-hex digits) is dropped, not decoded to U+0000 — parseInt's NaN
        // would otherwise coerce through String.fromCharCode into a stray NUL byte.
        if (!Number.isNaN(code)) appendDecoded(String.fromCharCode(code));
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
      boundaryPending = false;
      pendingSentence = '';
      pendingRun = '';
      pendingHigh = '';
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
      case 'beforeValue': {
        if (/\s/.test(c)) return;
        const isToolCalls = frame.kind === 'top' && frame.key === 'tool_calls';
        if (c === '"') {
          if (isToolCalls) resolveToolCalls(false); // a string is never null/[] — fail closed now
          openString(frame);
          return;
        }
        if (c === '[') {
          if (frame.kind === 'top' && frame.key === 'bubbles') {
            fireToolCallsIfNeeded(); // bubbles is about to speak — report tool_calls NOW if it hasn't
            stack.push({ kind: 'bubblesArray' });
          } else if (isToolCalls) {
            stack.push({ kind: 'toolCallsRoot', sawContent: false });
          } else {
            stack.push({ kind: 'generic' });
          }
          return;
        }
        if (c === '{') {
          if (isToolCalls) resolveToolCalls(false); // an object is never null/[] — fail closed now
          stack.push({ kind: 'generic' });
          return;
        }
        // A bare value (number / true / false / null) starts here — including tool_calls: null.
        inScalar = true;
        scalarBuf = c;
        return;
      }
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
    if (c === '"') {
      // The model replied with a bare string instead of {"text": ...} — it's still a bubble.
      stack.push({ kind: 'bareBubble', index: nextBubbleIndex++ });
      inString = true;
      stringRole = 'text';
      sentenceBuf = '';
      boundaryPending = false;
      pendingSentence = '';
      pendingRun = '';
      pendingHigh = '';
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
        if (f && f.kind === 'top' && f.key === 'tool_calls') {
          // tool_calls' only legal bare value is `null`; anything else (true/false/a number/a typo)
          // fails closed as non-empty rather than assuming it meant null.
          resolveToolCalls(scalarBuf === 'null');
        }
        scalarBuf = '';
        markValueResolved();
        processChar(c);
        return;
      }
      scalarBuf += c;
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
      case 'bareBubble':
        return; // unreachable while not inString — a bareBubble frame only exists mid-string
    }
  }

  return {
    push(delta: string): void {
      if (ended) return; // end() is terminal — nothing pushed after it is ever processed
      for (let i = 0; i < delta.length; i++) processChar(delta[i]);
    },
    end(): void {
      ended = true;
      // Nothing left open gets emitted: an unterminated string's partial sentence buffer, a
      // still-pending emoji lookahead, and any frame still on the stack are simply dropped. The
      // model never finished them, so relaying them would show Irises text she never actually said.
    },
  };
}
