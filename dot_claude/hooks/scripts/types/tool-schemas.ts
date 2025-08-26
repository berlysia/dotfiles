// Common ToolSchema declarations for cc-hooks-ts
// This file extends the base ToolSchema interface with Claude Code tool definitions

declare module "cc-hooks-ts" {
  interface ToolSchema {
    // File operations - Read is already defined in cc-hooks-ts, so we skip it to avoid conflicts
    
    Write: {
      input: {
        file_path: string;
        content: string;
      };
      response: {
        success: boolean;
      };
    };
    
    Edit: {
      input: {
        file_path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      };
      response: {
        success: boolean;
      };
    };
    
    MultiEdit: {
      input: {
        file_path: string;
        edits: Array<{
          old_string: string;
          new_string: string;
          replace_all?: boolean;
        }>;
      };
      response: {
        success: boolean;
      };
    };
    
    // Directory operations
    LS: {
      input: {
        path: string;
        ignore?: string[];
      };
      response: string; // Directory listing as text
    };
    
    Glob: {
      input: {
        pattern: string;
        path?: string;
      };
      response: {
        files: string[];
        numFiles: number;
        truncated: boolean;
        durationMs: number;
      };
    };
    
    Grep: {
      input: {
        pattern: string;
        path?: string;
        glob?: string;
        type?: string;
        output_mode?: "content" | "files_with_matches" | "count";
        "-i"?: boolean;
        "-n"?: boolean;
        "-A"?: number;
        "-B"?: number;
        "-C"?: number;
        head_limit?: number;
        multiline?: boolean;
      };
      response: {
        matches: string[];
        count?: number;
      };
    };
    
    // Shell operations
    Bash: {
      input: {
        command: string;
        description?: string;
        run_in_background?: boolean;
        timeout?: number;
      };
      response: {
        stdout: string;
        stderr: string;
        exit_code: number;
        interrupted: boolean;
        isImage: boolean;
      };
    };
    
    // Notebook operations
    NotebookRead: {
      input: {
        notebook_path: string;
      };
      response: string; // Notebook content
    };
    
    NotebookEdit: {
      input: {
        notebook_path: string;
        cell_number?: number;
        cell_id?: string;
        new_source: string;
        cell_type?: "code" | "markdown";
        edit_mode?: "replace" | "insert" | "delete";
      };
      response: {
        success: boolean;
      };
    };
  }
}