#!/usr/bin/env node --test

import { describe, it } from "node:test";
import { strictEqual } from "node:assert";
import { stripChezmoiAttributes } from "../implementations/chezmoi-redirect.ts";

describe("stripChezmoiAttributes", () => {
  describe("basic filenames", () => {
    it("should return unchanged filename without attributes", () => {
      strictEqual(stripChezmoiAttributes("config.toml"), "config.toml");
    });

    it("should convert dot_ prefix to leading dot", () => {
      strictEqual(stripChezmoiAttributes("dot_bashrc"), ".bashrc");
      strictEqual(stripChezmoiAttributes("dot_config"), ".config");
    });
  });

  describe("suffixes", () => {
    it("should strip .tmpl suffix", () => {
      strictEqual(stripChezmoiAttributes("config.toml.tmpl"), "config.toml");
    });

    it("should strip .age suffix", () => {
      strictEqual(stripChezmoiAttributes("secrets.yaml.age"), "secrets.yaml");
    });

    it("should strip .asc suffix", () => {
      strictEqual(stripChezmoiAttributes("secrets.yaml.asc"), "secrets.yaml");
    });

    it("should strip .literal suffix", () => {
      strictEqual(stripChezmoiAttributes("file.txt.literal"), "file.txt");
    });
  });

  describe("prefixes", () => {
    it("should strip private_ prefix", () => {
      strictEqual(stripChezmoiAttributes("private_secret.txt"), "secret.txt");
    });

    it("should strip executable_ prefix", () => {
      strictEqual(stripChezmoiAttributes("executable_script.sh"), "script.sh");
    });

    it("should strip empty_ prefix", () => {
      strictEqual(stripChezmoiAttributes("empty_placeholder"), "placeholder");
    });

    it("should strip readonly_ prefix", () => {
      strictEqual(stripChezmoiAttributes("readonly_config.txt"), "config.txt");
    });

    it("should strip encrypted_ prefix", () => {
      strictEqual(stripChezmoiAttributes("encrypted_secrets.yaml"), "secrets.yaml");
    });

    it("should strip create_ prefix", () => {
      strictEqual(stripChezmoiAttributes("create_newfile.txt"), "newfile.txt");
    });

    it("should strip modify_ prefix", () => {
      strictEqual(stripChezmoiAttributes("modify_existing.txt"), "existing.txt");
    });

    it("should strip symlink_ prefix", () => {
      strictEqual(stripChezmoiAttributes("symlink_link.txt"), "link.txt");
    });

    it("should strip run_ prefix", () => {
      strictEqual(stripChezmoiAttributes("run_script.sh"), "script.sh");
    });

    it("should strip run_once_ prefix", () => {
      strictEqual(stripChezmoiAttributes("run_once_setup.sh"), "setup.sh");
    });

    it("should strip run_onchange_ prefix", () => {
      strictEqual(stripChezmoiAttributes("run_onchange_update.sh"), "update.sh");
    });

    it("should strip literal_ prefix", () => {
      strictEqual(stripChezmoiAttributes("literal_dot_file"), ".file");
    });
  });

  describe("combined attributes", () => {
    it("should strip private_ + executable_ prefixes", () => {
      strictEqual(stripChezmoiAttributes("private_executable_script.sh"), "script.sh");
    });

    it("should strip prefix + .tmpl suffix", () => {
      strictEqual(stripChezmoiAttributes("private_config.yaml.tmpl"), "config.yaml");
    });

    it("should handle dot_ with prefix", () => {
      strictEqual(stripChezmoiAttributes("private_dot_bashrc"), ".bashrc");
    });

    it("should handle dot_ with suffix", () => {
      strictEqual(stripChezmoiAttributes("dot_bashrc.tmpl"), ".bashrc");
    });

    it("should handle all combined: prefix + dot_ + suffix", () => {
      strictEqual(stripChezmoiAttributes("private_dot_secret.tmpl"), ".secret");
    });

    it("should handle encrypted with .age suffix", () => {
      strictEqual(stripChezmoiAttributes("encrypted_dot_ssh_config.age"), ".ssh_config");
    });

    it("should handle multiple prefixes in order", () => {
      strictEqual(
        stripChezmoiAttributes("private_readonly_executable_script.sh"),
        "script.sh"
      );
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", () => {
      strictEqual(stripChezmoiAttributes(""), "");
    });

    it("should not strip partial prefix matches", () => {
      strictEqual(stripChezmoiAttributes("private"), "private");
      strictEqual(stripChezmoiAttributes("dot"), "dot");
    });

    it("should handle filename with underscore not being a prefix", () => {
      strictEqual(stripChezmoiAttributes("my_private_file.txt"), "my_private_file.txt");
    });

    it("should handle .tmpl in middle of filename", () => {
      strictEqual(stripChezmoiAttributes("file.tmpl.backup"), "file.tmpl.backup");
    });
  });
});
