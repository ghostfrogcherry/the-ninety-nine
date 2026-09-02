/**
 * Streaming reader for Scryfall bulk-data files.
 *
 * The `default_cards` payload is ~500MB uncompressed. `JSON.parse(readFileSync())`
 * blows the V8 heap long before it finishes, so every card is parsed
 * incrementally and handed to the caller one object at a time. Peak memory here
 * is one chunk plus one card, regardless of file size.
 *
 * TWO wire formats are supported, sniffed from the bytes rather than assumed:
 *
 *  1. JSON Lines  — one complete card object per line. This is what Scryfall
 *     actually serves today (`jsonl_download_uri`, gzip-compressed).
 *  2. JSON array  — a single top-level `[ {...}, {...} ]`. This is the older
 *     `download_uri` format. As of 2026-09 the `.json` array files 404 and the
 *     `download_uri` field is gone from /bulk-data entirely, but the array
 *     reader is kept because the format is trivially re-derivable, it costs
 *     nothing, and a format flip-flop must not take the weekly cron down.
 *
 * Gzip is detected from the magic bytes (1f 8b), not the file extension, so a
 * plain or compressed file of either format all work through one entry point.
 *
 * No dependencies. A stream-JSON package would work but is not needed: a
 * top-level array is separable with a depth counter plus string/escape state,
 * and JSON Lines needs only `indexOf('\n')`.
 */

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const CH_TAB = 9;
const CH_LF = 10;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_QUOTE = 34;
const CH_COMMA = 44;
const CH_LBRACKET = 91;
const CH_BACKSLASH = 92;
const CH_RBRACKET = 93;
const CH_LBRACE = 123;
const CH_RBRACE = 125;

function isWhitespace(code) {
  return code === CH_SPACE || code === CH_LF || code === CH_TAB || code === CH_CR;
}

/** Yield `head`, then everything left in an already-partly-consumed iterator. */
async function* prepend(head, iterator) {
  yield head;
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) return;
    yield value;
  }
}

/**
 * Gunzip the stream if it starts with the gzip magic number, otherwise pass the
 * bytes through untouched.
 *
 * @param {AsyncIterable<Buffer|Uint8Array>} source
 * @returns {AsyncGenerator<Buffer>}
 */
export async function* gunzipIfNeeded(source) {
  const iterator = source[Symbol.asyncIterator]();

  // A chunk boundary could in principle fall between the two magic bytes.
  let head = Buffer.alloc(0);
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    head = head.length === 0 ? Buffer.from(value) : Buffer.concat([head, Buffer.from(value)]);
    if (head.length >= 2) break;
  }
  if (head.length === 0) return;

  const body = prepend(head, iterator);
  if (head[0] !== 0x1f || head[1] !== 0x8b) {
    yield* body;
    return;
  }

  const gunzip = createGunzip();
  const input = Readable.from(body);
  // .pipe() does not forward source errors; without this a read failure mid-file
  // would hang the gunzip stream instead of rejecting.
  input.on("error", (err) => gunzip.destroy(err));
  input.pipe(gunzip);
  yield* gunzip;
}

/**
 * Decode bytes to text without splitting a multi-byte UTF-8 sequence across a
 * chunk boundary. Card names and oracle text are full of non-ASCII (`—`, `Æ`,
 * accented names), so a naive `chunk.toString()` per chunk corrupts them.
 *
 * @param {AsyncIterable<Buffer|Uint8Array>} byteChunks
 * @returns {AsyncGenerator<string>}
 */
export async function* decodeUtf8(byteChunks) {
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of byteChunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/**
 * Parse a top-level JSON array incrementally, yielding one element at a time.
 *
 * Only the array's own delimiters are scanned by hand; each element is handed to
 * the native `JSON.parse` once complete, so element parsing stays fully spec
 * compliant. An individual card is a few KB, which is safe to buffer.
 *
 * Elements must be objects or arrays (which is what every Scryfall bulk file
 * contains); a top-level scalar throws rather than being silently dropped.
 *
 * @param {AsyncIterable<string>} textChunks
 * @returns {AsyncGenerator<unknown>}
 */
export async function* parseJsonArray(textChunks) {
  let opened = false;
  let closed = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  /** Bytes of the current element carried over from previous chunks. */
  let pending = "";
  /** Index in the current chunk where the current element starts. */
  let elementStart = -1;

  for await (const chunk of textChunks) {
    if (closed) {
      if (/\S/.test(chunk)) throw new Error("trailing data after end of JSON array");
      continue;
    }

    const length = chunk.length;
    let i = 0;

    if (!opened) {
      while (i < length && isWhitespace(chunk.charCodeAt(i))) i++;
      if (i === length) continue;
      if (chunk.charCodeAt(i) !== CH_LBRACKET) {
        throw new Error(
          `expected '[' at start of JSON array, got ${JSON.stringify(chunk[i])}`,
        );
      }
      opened = true;
      i++;
    }

    for (; i < length; i++) {
      const code = chunk.charCodeAt(i);

      if (depth === 0) {
        if (isWhitespace(code) || code === CH_COMMA) continue;
        if (code === CH_RBRACKET) {
          closed = true;
          i++;
          break;
        }
        if (code === CH_LBRACE || code === CH_LBRACKET) {
          elementStart = i;
          depth = 1;
          inString = false;
          escaped = false;
          continue;
        }
        throw new Error(
          `unexpected character ${JSON.stringify(chunk[i])} at top level of JSON array`,
        );
      }

      if (inString) {
        // Braces and brackets inside string values (mana costs like "{2}{G/W}",
        // oracle text, flavour text) must not move the depth counter.
        if (escaped) escaped = false;
        else if (code === CH_BACKSLASH) escaped = true;
        else if (code === CH_QUOTE) inString = false;
        continue;
      }

      if (code === CH_QUOTE) {
        inString = true;
      } else if (code === CH_LBRACE || code === CH_LBRACKET) {
        depth++;
      } else if (code === CH_RBRACE || code === CH_RBRACKET) {
        depth--;
        if (depth === 0) {
          const text = pending + chunk.slice(elementStart, i + 1);
          pending = "";
          elementStart = -1;
          yield JSON.parse(text);
        }
      }
    }

    if (closed) {
      if (/\S/.test(chunk.slice(i))) {
        throw new Error("trailing data after end of JSON array");
      }
      continue;
    }

    if (depth > 0) {
      // Element straddles the chunk boundary: carry it and restart at 0.
      pending += chunk.slice(elementStart);
      elementStart = 0;
    }
  }

  if (!opened) throw new Error("no JSON array found in input");
  if (!closed) throw new Error("unexpected end of input: JSON array was never closed");
}

/**
 * Parse JSON Lines incrementally, yielding one object per non-blank line.
 *
 * @param {AsyncIterable<string>} textChunks
 * @returns {AsyncGenerator<unknown>}
 */
export async function* parseJsonLines(textChunks) {
  let carry = "";

  for await (const chunk of textChunks) {
    const text = carry ? carry + chunk : chunk;
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) break;
      // .trim() also absorbs the \r of CRLF.
      const line = text.slice(start, newline).trim();
      start = newline + 1;
      if (line) yield JSON.parse(line);
    }
    carry = start === 0 ? text : text.slice(start);
  }

  const last = carry.trim();
  if (last) yield JSON.parse(last);
}

/**
 * Sniff the format from the first non-whitespace character and dispatch.
 *
 * @param {AsyncIterable<string>} textChunks
 * @returns {AsyncGenerator<unknown>}
 */
export async function* parseCardText(textChunks) {
  const iterator = textChunks[Symbol.asyncIterator]();

  let head = "";
  let first = "";
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    head += value;
    const match = /\S/.exec(head);
    if (match) {
      first = match[0];
      break;
    }
  }

  if (!first) throw new Error("bulk file is empty or contains only whitespace");

  const body = prepend(head, iterator);
  if (first === "[") {
    yield* parseJsonArray(body);
  } else if (first === "{") {
    yield* parseJsonLines(body);
  } else {
    throw new Error(
      `unrecognised bulk file format: expected '[' (JSON array) or '{' (JSON Lines), got ${JSON.stringify(first)}`,
    );
  }
}

/**
 * Full pipeline: raw bytes -> optional gunzip -> UTF-8 -> card objects.
 *
 * @param {AsyncIterable<Buffer|Uint8Array>} byteChunks
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export function streamCards(byteChunks) {
  return parseCardText(decodeUtf8(gunzipIfNeeded(byteChunks)));
}

/**
 * Stream card objects out of a bulk file on disk, compressed or not.
 *
 * @param {string} filePath
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export function streamCardsFromFile(filePath) {
  return streamCards(createReadStream(filePath));
}
