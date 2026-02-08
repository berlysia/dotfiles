// Common ToolSchema declarations for cc-hooks-ts
// This file extends the base ToolSchema interface with Claude Code tool definitions
// that are not yet included in the cc-hooks-ts library

// Export statement to make this file a module (required for module augmentation)
export {};

declare module "cc-hooks-ts" {
  interface ToolSchema {
    /**
     * MultiEdit tool for making multiple edits to a single file
     */
    MultiEdit: {
      input: {
        file_path: string;
        edits: Array<{
          old_string: string;
          new_string: string;
        }>;
      };
      response: {
        filePath: string;
        edits: Array<{
          oldString: string;
          newString: string;
          structuredPatch: Array<{
            lines: string[];
            newLines: number;
            newStart: number;
            oldLines: number;
            oldStart: number;
          }>;
        }>;
        originalFile: string;
        userModified: boolean;
      };
    };
  }
}
