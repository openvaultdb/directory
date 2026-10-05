// Adapted from demo-db/chinook@39e1830b1ad1f190e62cbfa9f3eec96ae28e92dc.
// MIT licence; see representation-LICENSE.txt.
import { TextDecoder } from 'node:util';

const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

// JSON.parse accepts duplicate object members and unpaired escaped surrogates.
// Scan the complete grammar before returning its value so neither can be lost.
export function parseStrictJson(bytes, limit, label = 'JSON', { losslessNumbers = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > limit) throw new Error(`${label}: byte limit exceeded`);
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`${label}: invalid UTF-8`); }
  if (source.charCodeAt(0) === 0xfeff) throw new Error(`${label}: UTF-8 BOM is not allowed`);
  let at = 0;
  const fail = (message) => { throw new Error(`${label}: ${message} at offset ${at}`); };
  const space = () => { while (/[\t\n\r ]/.test(source[at] ?? '\0')) at++; };
  const string = () => {
    if (source[at++] !== '"') fail('expected string');
    let value = '';
    while (at < source.length) {
      const ch = source[at++];
      if (ch === '"') return value;
      if (ch.charCodeAt(0) < 0x20) fail('control character in string');
      if (ch !== '\\') { value += ch; continue; }
      const escaped = source[at++];
      if (Object.hasOwn(escapes, escaped)) { value += escapes[escaped]; continue; }
      if (escaped !== 'u' || !/^[0-9a-fA-F]{4}$/.test(source.slice(at, at + 4))) fail('invalid escape');
      const scalar = parseInt(source.slice(at, at + 4), 16); at += 4;
      if (scalar >= 0xdc00 && scalar <= 0xdfff) fail('unpaired low surrogate');
      if (scalar >= 0xd800 && scalar <= 0xdbff) {
        if (source.slice(at, at + 2) !== '\\u' || !/^[0-9a-fA-F]{4}$/.test(source.slice(at + 2, at + 6))) fail('unpaired high surrogate');
        const low = parseInt(source.slice(at + 2, at + 6), 16);
        if (low < 0xdc00 || low > 0xdfff) fail('unpaired high surrogate');
        at += 6;
        value += String.fromCodePoint(0x10000 + (scalar - 0xd800) * 0x400 + low - 0xdc00);
      } else value += String.fromCharCode(scalar);
    }
    fail('unterminated string');
  };
  const value = (depth) => {
    if (depth > 32) fail('JSON depth exceeds 32');
    space();
    const ch = source[at];
    if (ch === '"') return string();
    if (ch === '{') {
      at++; space(); const seen = new Set(); const result = Object.create(null);
      if (source[at] === '}') { at++; return result; }
      while (at < source.length) {
        const key = string();
        if (seen.has(key)) fail(`duplicate JSON key ${JSON.stringify(key)}`);
        seen.add(key); space(); if (source[at++] !== ':') fail('expected colon');
        result[key] = value(depth + 1); space();
        const delimiter = source[at++];
        if (delimiter === '}') return result;
        if (delimiter !== ',') fail('expected object delimiter');
        space();
      }
      fail('unterminated object');
    }
    if (ch === '[') {
      at++; space(); const result = []; if (source[at] === ']') { at++; return result; }
      while (at < source.length) {
        result.push(value(depth + 1)); space();
        const delimiter = source[at++];
        if (delimiter === ']') return result;
        if (delimiter !== ',') fail('expected array delimiter');
      }
      fail('unterminated array');
    }
    const tail = source.slice(at);
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(tail)?.[0];
    if (!token) fail('invalid value');
    at += token.length;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    return { $jsonNumberToken: token };
  };
  const parsed = value(0); space();
  if (at !== source.length) fail('trailing data');
  return losslessNumbers ? parsed : JSON.parse(source);
}
