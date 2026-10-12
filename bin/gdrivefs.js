#!/usr/bin/env node
/**
 * gdrivefs CLI のエントリポイント。
 *
 * 例:
 *   gdrivefs --memory ls /          # 認証なしで動作確認
 *   gdrivefs put ./docs /backup     # 実 Drive へアップロード
 */

import { main } from '../src/cli.js';

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
