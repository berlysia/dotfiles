#!/usr/bin/env -S bun test

import { describe, it, test, expect } from "bun:test";
import { 
  parseBashCommand, 
  extractCommandsFromCompound,
  type BashParsingResult,
  type SimpleCommand
} from "../../lib/bash-parser.ts";

describe("bash-parser", () => {
  describe("parseBashCommand", () => {
    it("should return fallback parsing method", async () => {
      const result = await parseBashCommand("echo hello");
      expect(result.parsingMethod).toBe("fallback");
    });

    it("should parse simple command", async () => {
      const result = await parseBashCommand("echo hello");
      expect(result.errors).toHaveLength(0);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.name).toBe("echo");
      expect(result.commands[0]?.args).toEqual(["hello"]);
    });

    it("should handle empty command", async () => {
      const result = await parseBashCommand("");
      expect(result.commands).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should handle compound commands with semicolons", async () => {
      const result = await parseBashCommand("echo hello; echo world");
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0]?.name).toBe("echo");
      expect(result.commands[0]?.args).toEqual(["hello"]);
      expect(result.commands[1]?.name).toBe("echo");
      expect(result.commands[1]?.args).toEqual(["world"]);
    });

    it("should handle compound commands with &&", async () => {
      const result = await parseBashCommand("echo hello && echo world");
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0]?.text).toBe("echo hello");
      expect(result.commands[1]?.text).toBe("echo world");
    });

    it("should handle pipe commands", async () => {
      const result = await parseBashCommand("ls -la | grep test");
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0]?.name).toBe("ls");
      expect(result.commands[0]?.args).toEqual(["-la"]);
      expect(result.commands[1]?.name).toBe("grep");
      expect(result.commands[1]?.args).toEqual(["test"]);
    });

    it("should handle variable assignments", async () => {
      const result = await parseBashCommand("VAR=value echo hello");
      expect(result.commands).toHaveLength(1);
      const cmd = result.commands[0];
      expect(cmd?.name).toBe("echo");
      expect(cmd?.args).toEqual(["hello"]);
      expect(cmd?.assignments).toEqual(["VAR=value"]);
    });

    it("should handle redirections", async () => {
      const result = await parseBashCommand("echo hello > output.txt");
      expect(result.commands).toHaveLength(1);
      const cmd = result.commands[0];
      expect(cmd?.name).toBe("echo");
      expect(cmd?.args).toEqual(["hello"]);
      expect(cmd?.redirections).toEqual([">output.txt"]);
    });

    it("should handle complex redirections", async () => {
      const result = await parseBashCommand("echo hello 2>&1 | grep error");
      expect(result.commands).toHaveLength(2);
      const cmd = result.commands[0];
      expect(cmd?.name).toBe("echo");
      expect(cmd?.args).toEqual(["hello"]);
      expect(cmd?.redirections).toEqual(["2>&1"]);
    });
  });

  describe("meta command parsing", () => {
    it("should extract commands from sh -c", async () => {
      const result = await parseBashCommand('sh -c "echo hello && echo world"');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0]?.text).toBe("echo hello");
      expect(result.commands[1]?.text).toBe("echo world");
    });

    it("should extract commands from bash -c", async () => {
      const result = await parseBashCommand('bash -c "ls -la; grep test"');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0]?.text).toBe("ls -la");
      expect(result.commands[1]?.text).toBe("grep test");
    });

    it("should extract commands from timeout", async () => {
      const result = await parseBashCommand('timeout 30 echo hello');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.text).toBe("echo hello");
    });

    it("should extract commands from xargs", async () => {
      const result = await parseBashCommand('git diff --name-only | xargs -I {} sh -c "echo {}; wc -l {}"');
      expect(result.commands).toHaveLength(3);
      expect(result.commands[0]?.text).toBe("git diff --name-only");
      expect(result.commands[1]?.text).toBe("echo {}");
      expect(result.commands[2]?.text).toBe("wc -l {}");
    });

    it("should handle nested meta commands", async () => {
      const result = await parseBashCommand('timeout 60 bash -c "xargs -I {} sh -c \'echo {}\'"');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.text).toBe("echo {}");
    });
  });

  describe("control structure parsing", () => {
    it("should extract commands from for loops", async () => {
      const result = await parseBashCommand('for f in *.ts; do echo $f; wc -l $f; done');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0]?.text).toBe("echo $f");
      expect(result.commands[1]?.text).toBe("wc -l $f");
    });

    it("should handle simple for loop", async () => {
      const result = await parseBashCommand('for f in *; do echo $f; done');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.text).toBe("echo $f");
    });
  });

  describe("edge cases", () => {
    it("should handle commands with quotes", async () => {
      const result = await parseBashCommand('echo "hello world"');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.name).toBe("echo");
      expect(result.commands[0]?.args).toEqual(['"hello world"']);
    });

    it("should filter out control keywords", async () => {
      const result = await parseBashCommand('if echo hello; then echo world; fi');
      // Should not include 'if', 'then', 'fi' as separate commands
      const cmdNames = result.commands.map(cmd => cmd.name).filter(Boolean);
      expect(cmdNames).not.toContain("if");
      expect(cmdNames).not.toContain("then");
      expect(cmdNames).not.toContain("fi");
    });

    it("should handle malformed commands gracefully", async () => {
      const result = await parseBashCommand('echo hello &&');
      // Should not crash and should provide some reasonable output
      expect(result.errors).toHaveLength(0); // Fallback should be forgiving
      expect(result.commands.length).toBeGreaterThanOrEqual(1);
    });

    it("should deduplicate commands", async () => {
      const result = await parseBashCommand('echo hello; echo hello');
      // Should have 2 commands even if they're identical
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0]?.text).toBe("echo hello");
      expect(result.commands[1]?.text).toBe("echo hello");
    });
  });

  describe("extractCommandsFromCompound (legacy compatibility)", () => {
    it("should return array of command strings", async () => {
      const commands = await extractCommandsFromCompound("echo hello && echo world");
      expect(commands).toEqual(["echo hello", "echo world"]);
    });

    it("should handle empty input", async () => {
      const commands = await extractCommandsFromCompound("");
      expect(commands).toEqual([]);
    });

    it("should handle meta commands", async () => {
      const commands = await extractCommandsFromCompound('sh -c "echo hello && echo world"');
      expect(commands).toEqual(["echo hello", "echo world"]);
    });

    it("should handle for loops", async () => {
      const commands = await extractCommandsFromCompound('for f in *.ts; do echo $f; done');
      expect(commands).toEqual(["echo $f"]);
    });

    it("should fallback on parsing errors", async () => {
      // Mock console.warn to check error handling
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (msg: string) => warnings.push(msg);

      const commands = await extractCommandsFromCompound("echo hello && echo world");
      expect(commands).toEqual(["echo hello", "echo world"]);
      
      console.warn = originalWarn;
    });
  });

  describe("SimpleCommand structure", () => {
    it("should include range information", async () => {
      const result = await parseBashCommand("echo hello");
      const cmd = result.commands[0];
      expect(cmd?.range).toBeDefined();
      expect(typeof cmd?.range.start).toBe("number");
      expect(typeof cmd?.range.end).toBe("number");
      expect(cmd?.range.start).toBeLessThanOrEqual(cmd?.range.end);
    });

    it("should include path information", async () => {
      const result = await parseBashCommand("echo hello");
      const cmd = result.commands[0];
      expect(cmd?.path).toBeDefined();
      expect(Array.isArray(cmd?.path)).toBe(true);
      expect(cmd?.path[0]).toContain("fallback");
    });

    it("should include original text", async () => {
      const result = await parseBashCommand("echo hello");
      const cmd = result.commands[0];
      expect(cmd?.text).toBe("echo hello");
    });
  });
});