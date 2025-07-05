#!/usr/bin/env node
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { checkBashCommand } from './block-tsx-tsnode.ts';

describe('checkBashCommand', () => {
  describe('Package installation blocking', () => {
    test('should block npm install tsx', () => {
      const result = checkBashCommand('npm install tsx');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Installation of tsx is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block npm install ts-node', () => {
      const result = checkBashCommand('npm install ts-node');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Installation of ts-node is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block yarn add tsx', () => {
      const result = checkBashCommand('yarn add tsx');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Installation of tsx is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block pnpm add ts-node', () => {
      const result = checkBashCommand('pnpm add ts-node');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Installation of ts-node is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block bun install tsx', () => {
      const result = checkBashCommand('bun install tsx');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Installation of tsx is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block tsx with version specifier', () => {
      const result = checkBashCommand('npm install tsx@latest');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Installation of tsx is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block ts-node with version specifier', () => {
      const result = checkBashCommand('npm install ts-node@4.0.0');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Installation of ts-node is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block installation with dev flags', () => {
      const result = checkBashCommand('npm install -D tsx');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Installation of tsx is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block installation with multiple packages including tsx', () => {
      const result = checkBashCommand('npm install lodash tsx express');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Installation of tsx is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should allow installation of packages with similar names', () => {
      const result = checkBashCommand('npm install tsx-loader');
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reason, null);
    });

    test('should allow installation of packages with similar names', () => {
      const result = checkBashCommand('npm install react-tsx-parser');
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reason, null);
    });

    test('should allow installation of other packages', () => {
      const result = checkBashCommand('npm install express');
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reason, null);
    });
  });

  describe('Node.js loader blocking', () => {
    test('should block node --loader tsx', () => {
      const result = checkBashCommand('node --loader tsx script.ts');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Using tsx/ts-node as a loader is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block node --require ts-node', () => {
      const result = checkBashCommand('node --require ts-node/register script.ts');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Using tsx/ts-node as a loader is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block node --experimental-loader ts-node', () => {
      const result = checkBashCommand('node --experimental-loader ts-node/esm script.ts');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Using tsx/ts-node as a loader is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should allow node with other loaders', () => {
      const result = checkBashCommand('node --loader babel-loader script.js');
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reason, null);
    });
  });

  describe('npx usage blocking', () => {
    test('should block npx tsx', () => {
      const result = checkBashCommand('npx tsx script.ts');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Running tsx/ts-node via npx is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block npx ts-node', () => {
      const result = checkBashCommand('npx ts-node index.ts');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Running tsx/ts-node via npx is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block npx with whitespace', () => {
      const result = checkBashCommand('  npx tsx  script.ts');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Running tsx/ts-node via npx is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should allow npx with other tools', () => {
      const result = checkBashCommand('npx eslint src/');
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reason, null);
    });
  });

  describe('Direct execution blocking', () => {
    test('should block tsx script.ts', () => {
      const result = checkBashCommand('tsx script.ts');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Direct execution of TypeScript files with tsx/ts-node is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block ts-node app.ts', () => {
      const result = checkBashCommand('ts-node app.ts');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Direct execution of TypeScript files with tsx/ts-node is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should block with whitespace', () => {
      const result = checkBashCommand('  tsx  script.ts');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reason, 'Direct execution of TypeScript files with tsx/ts-node is prohibited. Use the existing TypeScript toolchain in the project.');
    });

    test('should allow tsx with flags (should not match)', () => {
      const result = checkBashCommand('tsx --help');
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reason, null);
    });

    test('should allow .tsx files (React components)', () => {
      const result = checkBashCommand('code Component.tsx');
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reason, null);
    });
  });

  describe('Edge cases', () => {
    test('should handle empty command', () => {
      const result = checkBashCommand('');
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reason, null);
    });

    test('should handle whitespace only command', () => {
      const result = checkBashCommand('   ');
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reason, null);
    });

    test('should handle commands with tsx/ts-node in file paths', () => {
      const result = checkBashCommand('cat /path/to/tsx/file.txt');
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reason, null);
    });

    test('should handle commands with tsx/ts-node in arguments', () => {
      const result = checkBashCommand('grep "tsx" file.txt');
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reason, null);
    });
  });
});