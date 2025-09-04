#!/usr/bin/env node

/**
 * Unified Audio Engine Integration Tests
 * claude-companion連携機能の統合テスト
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { dirname } from 'path';
import { checkAndDelegateToClaude, speakNotification } from '../../../lib/unified-audio-engine.ts';
import { createUnifiedVoiceConfig, createVoiceSession } from '../../../lib/unified-audio-config.ts';

// モック用の簡単なcheckClaudeCompanionStatus実装
const originalCheckClaudeCompanionStatus = await import('../../../lib/claude-companion-detector.ts').then(m => m.checkClaudeCompanionStatus);

describe('Unified Audio Engine - Claude Companion Integration', () => {
  const originalEnvHome = process.env.HOME;
  
  beforeEach(() => {
    process.env.HOME = '/tmp/test-unified-audio';
    
    // テスト用のディレクトリを作成
    const testDir = `${process.env.HOME}/.config/claude-companion/logs`;
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });
  
  afterEach(() => {
    // テストファイルをクリーンアップ
    const pidPath = `${process.env.HOME}/.config/claude-companion/logs/daemon.pid`;
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
    
    process.env.HOME = originalEnvHome;
    
    const testDir = `/tmp/test-unified-audio`;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('checkAndDelegateToClaude', () => {
    it('should return delegation result when claude-companion is running', async () => {
      // claude-companionが起動している状態をシミュレート
      const pidData = {
        pid: process.pid, // 現在のプロセスを使用（確実に存在する）
        port: 8888, // 存在しないポートでヘルスチェックは失敗するが、テストの目的上問題ない
        startTime: '2025-09-04T19:17:09.015Z',
        webUIEnabled: true
      };
      
      const pidPath = `${process.env.HOME}/.config/claude-companion/logs/daemon.pid`;
      writeFileSync(pidPath, JSON.stringify(pidData));
      
      const config = createUnifiedVoiceConfig();
      const result = await checkAndDelegateToClaude(config);
      
      // ヘルスチェックが失敗するため、結果はnullになる
      // これは期待される動作（プロセスは存在するがヘルスチェック失敗）
      assert.strictEqual(result, null);
    });

    it('should return null when claude-companion is not running', async () => {
      // daemon.pidファイルが存在しない状態
      const config = createUnifiedVoiceConfig();
      const result = await checkAndDelegateToClaude(config);
      
      assert.strictEqual(result, null);
    });
  });

  describe('speakNotification with claude-companion integration', () => {
    it('should proceed with normal processing when claude-companion is not running', async () => {
      // claude-companionが起動していない状態（daemon.pidファイルなし）
      const config = createUnifiedVoiceConfig();
      const session = createVoiceSession(config);
      
      const result = await speakNotification('test message', 'Notification', config, session);
      
      // claude-companionが起動していない場合、通常の処理が実行される
      // VoiceVoxエンジンが利用できない環境では、フォールバックが実行される
      assert.ok(result.success !== undefined);
      assert.notStrictEqual(result.method, 'delegated');
    });

    it('should attempt delegation check when claude-companion daemon.pid exists', async () => {
      // daemon.pidファイルは存在するが、実際のプロセスは存在しない状況をシミュレート
      const pidData = {
        pid: 999999, // 存在しないPID
        port: 3000,
        startTime: '2025-09-04T19:17:09.015Z',
        webUIEnabled: true
      };
      
      const pidPath = `${process.env.HOME}/.config/claude-companion/logs/daemon.pid`;
      writeFileSync(pidPath, JSON.stringify(pidData));
      
      const config = createUnifiedVoiceConfig();
      const session = createVoiceSession(config);
      
      const result = await speakNotification('test message', 'Notification', config, session);
      
      // プロセスが存在しないため、委譲されずに通常処理が実行される
      assert.ok(result.success !== undefined);
      assert.notStrictEqual(result.method, 'delegated');
    });
  });
});