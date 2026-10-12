import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  basename,
  contains,
  dirname,
  join,
  normalize,
  segments,
  validateSegment,
} from '../src/path.js';
import { InvalidPathError } from '../src/errors.js';

describe('path ユーティリティ', () => {
  it('normalize は絶対パスに正規化する', () => {
    assert.equal(normalize('a/b'), '/a/b');
    assert.equal(normalize('/a//b/'), '/a/b');
    assert.equal(normalize('/a/./b'), '/a/b');
    assert.equal(normalize('/a/b/../c'), '/a/c');
    assert.equal(normalize('..'), '/');
    assert.equal(normalize(''), '/');
    assert.equal(normalize('/'), '/');
  });

  it('segments は配列に分解する', () => {
    assert.deepEqual(segments('/a/b/c'), ['a', 'b', 'c']);
    assert.deepEqual(segments('/'), []);
  });

  it('join / basename / dirname が一貫している', () => {
    assert.equal(join('/a', 'b', 'c.txt'), '/a/b/c.txt');
    assert.equal(basename('/a/b/c.txt'), 'c.txt');
    assert.equal(basename('/'), '/');
    assert.equal(dirname('/a/b/c.txt'), '/a/b');
    assert.equal(dirname('/a'), '/');
  });

  it('contains は配下判定をする', () => {
    assert.equal(contains('/a', '/a/b/c'), true);
    assert.equal(contains('/a', '/a'), true);
    assert.equal(contains('/a', '/ab'), false);
    assert.equal(contains('/a/b', '/a'), false);
  });

  it('不正なセグメントを弾く', () => {
    assert.throws(() => validateSegment(''), InvalidPathError);
    assert.throws(() => validateSegment('.'), InvalidPathError);
    assert.throws(() => validateSegment('..'), InvalidPathError);
    assert.throws(() => validateSegment('a/b'), InvalidPathError);
    assert.throws(() => validateSegment('a\u0000b'), InvalidPathError);
    assert.throws(() => validateSegment(' pad '), InvalidPathError);
    assert.throws(() => validateSegment('x'.repeat(300)), InvalidPathError);
    assert.equal(validateSegment('ok-name_1.txt'), 'ok-name_1.txt');
  });

  it('深すぎる階層を弾く', () => {
    assert.throws(() => normalize(`/${Array.from({ length: 101 }, () => 'd').join('/')}`));
  });

  it('文字列以外は拒否する', () => {
    assert.throws(() => normalize(42), InvalidPathError);
  });
});
