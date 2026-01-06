import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatChezmoiRedirectMessage,
  stripChezmoiAttributes,
} from "../../lib/chezmoi-utils.ts";

describe("chezmoi-utils", () => {
  describe("stripChezmoiAttributes", () => {
    it("should strip dot_ prefix and convert to leading dot", () => {
      assert.equal(stripChezmoiAttributes("dot_bashrc"), ".bashrc");
      assert.equal(stripChezmoiAttributes("dot_config"), ".config");
      assert.equal(stripChezmoiAttributes("dot_gitconfig"), ".gitconfig");
    });

    it("should strip private_ prefix", () => {
      assert.equal(stripChezmoiAttributes("private_dot_ssh"), ".ssh");
      assert.equal(stripChezmoiAttributes("private_key"), "key");
    });

    it("should strip .tmpl suffix", () => {
      assert.equal(stripChezmoiAttributes("dot_bashrc.tmpl"), ".bashrc");
      assert.equal(stripChezmoiAttributes("config.tmpl"), "config");
    });

    it("should strip multiple prefixes", () => {
      assert.equal(
        stripChezmoiAttributes("private_readonly_dot_config"),
        ".config",
      );
      assert.equal(
        stripChezmoiAttributes("executable_private_script.sh"),
        "script.sh",
      );
    });

    it("should handle run_ prefixes", () => {
      assert.equal(stripChezmoiAttributes("run_once_setup.sh"), "setup.sh");
      assert.equal(
        stripChezmoiAttributes("run_onchange_update.sh"),
        "update.sh",
      );
      assert.equal(stripChezmoiAttributes("run_before_init.sh"), "init.sh");
      assert.equal(
        stripChezmoiAttributes("run_after_cleanup.sh"),
        "cleanup.sh",
      );
    });

    it("should strip .age suffix for encrypted files", () => {
      assert.equal(stripChezmoiAttributes("secret.age"), "secret");
      assert.equal(
        stripChezmoiAttributes("encrypted_dot_secrets.age"),
        ".secrets",
      );
    });

    it("should handle files without chezmoi attributes", () => {
      assert.equal(stripChezmoiAttributes("README.md"), "README.md");
      assert.equal(stripChezmoiAttributes("package.json"), "package.json");
    });

    it("should handle symlink_ prefix", () => {
      assert.equal(stripChezmoiAttributes("symlink_dot_link"), ".link");
    });

    it("should handle create_ prefix", () => {
      assert.equal(stripChezmoiAttributes("create_dot_file"), ".file");
    });

    it("should handle modify_ prefix", () => {
      assert.equal(stripChezmoiAttributes("modify_dot_config"), ".config");
    });

    it("should strip .asc suffix", () => {
      assert.equal(stripChezmoiAttributes("secret.asc"), "secret");
    });

    it("should strip .literal suffix", () => {
      assert.equal(stripChezmoiAttributes("file.literal"), "file");
    });

    it("should handle literal_ prefix", () => {
      assert.equal(stripChezmoiAttributes("literal_dot_file"), ".file");
    });

    it("should handle complex combinations", () => {
      // private_encrypted_dot_secrets.age → .secrets
      assert.equal(
        stripChezmoiAttributes("private_encrypted_dot_secrets.age"),
        ".secrets",
      );

      // run_once_before_install.sh.tmpl → install.sh
      assert.equal(
        stripChezmoiAttributes("run_once_before_install.sh.tmpl"),
        "install.sh",
      );
    });
  });

  describe("formatChezmoiRedirectMessage", () => {
    it("should format redirect message correctly", () => {
      const message = formatChezmoiRedirectMessage(
        "/home/user/.bashrc",
        "/home/user/dotfiles/dot_bashrc",
      );

      assert.ok(message.includes("Chezmoi Redirect Required"));
      assert.ok(message.includes("❌ Requested: /home/user/.bashrc"));
      assert.ok(
        message.includes("✅ Use this:  /home/user/dotfiles/dot_bashrc"),
      );
      assert.ok(message.includes("chezmoi apply"));
    });

    it("should include source file guidance", () => {
      const message = formatChezmoiRedirectMessage(
        "/home/user/.config/mise/config.toml",
        "/home/user/dotfiles/dot_config/mise/config.toml",
      );

      assert.ok(message.includes("source file in the repository"));
      assert.ok(message.includes("canonical version"));
    });
  });
});
