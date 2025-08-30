#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";
import { extract, toMarkdown } from "@mizchi/readability";
import "../types/tool-schemas.ts";

/**
 * Web fetch guardian: Enhanced WebFetch with readability markdown conversion
 * Replaces WebFetch with @mizchi/readability for better content extraction
 */
export default defineHook({
  trigger: { PreToolUse: true },
  run: async (context) => {
    const { tool_name, tool_input } = context.input;

    // Only process WebFetch tools
    if (tool_name !== "WebFetch") {
      return context.success({});
    }

    try {
      // Extract URL from tool input
      const url = extractUrl(tool_name, tool_input);
      if (!url) {
        return context.success({});
      }

      // Check for GitHub access
      const githubCheck = checkGitHubAccess(url, tool_name);
      if (githubCheck.shouldBlock) {
        return context.blockingError(githubCheck.message || "Access blocked");
      }

      // For HTTP/HTTPS URLs, use readability to get markdown content
      if (isHttpUrl(url)) {
        const markdownContent = await fetchAsMarkdown(url);
        
        // Return the markdown content instead of allowing original WebFetch
        return context.success({ 
          messageForUser: `Fetched content as markdown from: ${url}\n\n${markdownContent}`
        });
      }

      // Allow non-HTTP URLs to proceed normally
      return context.success({});

    } catch (error) {
      return context.blockingError(`Error in web fetch guardian: ${error}`);
    }
  }
});

interface CheckResult {
  shouldBlock: boolean;
  message?: string;
}

/**
 * Extract URL from tool input
 */
function extractUrl(tool_name: string, tool_input: any): string | null {
  if (tool_name === "WebFetch") {
    return tool_input.url || null;
  }
  return null;
}

/**
 * Check if URL is HTTP/HTTPS
 */
function isHttpUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === "http:" || urlObj.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Fetch URL content as markdown using @mizchi/readability
 */
async function fetchAsMarkdown(url: string): Promise<string> {
  try {
    // Fetch HTML content
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    
    // Extract readable content
    const result = extract(html, { url });
    
    // Convert to markdown
    const contentMarkdown = toMarkdown(result.root);
    
    // Format with metadata header
    const title = result.metadata?.title || "Web Content";
    const metadata = [
      `# ${title}`,
      "",
      `**Source:** ${url}`,
      `**Extracted:** ${new Date().toISOString()}`,
      "",
      "---",
      "",
      contentMarkdown
    ].join("\n");
    
    return metadata;
  } catch (error) {
    throw new Error(`Failed to fetch content from ${url}: ${error}`);
  }
}

/**
 * Check if URL is trying to access GitHub and recommend gh CLI instead
 */
function checkGitHubAccess(url: string, tool_name: string): CheckResult {
  try {
    const urlObj = new URL(url);
    
    // Check if hostname is github.com or api.github.com
    const githubHosts = ["github.com", "api.github.com", "raw.githubusercontent.com"];
    const isGitHub = githubHosts.some(host => urlObj.hostname === host || urlObj.hostname.endsWith(`.${host}`));
    
    if (isGitHub) {
      return {
        shouldBlock: true,
        message: `Use "gh" CLI for GitHub requests instead of ${tool_name}.\n\nExample: gh api repos/owner/repo\n\nRequested URL: ${url}`
      };
    }

    return { shouldBlock: false };

  } catch (error) {
    // If URL parsing fails, allow the request
    return { shouldBlock: false };
  }
}

