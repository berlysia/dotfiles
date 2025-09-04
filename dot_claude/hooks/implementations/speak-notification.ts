#!/usr/bin/env -S bun run --silent

/**
 * Voice Notification Hook
 * cc-hooks-ts hook for Notification and Stop events using shared library
 */

import { defineHook } from "cc-hooks-ts";
import { 
  createAudioEngine,
  handleNotification, 
  handleStop,
  cleanupSession
} from '../../lib/unified-audio-engine.ts';
const hook = defineHook({
  trigger: {
    Notification: true,
    Stop: true
  },
  run: async (context) => {
    const eventType = context.input.hook_event_name as 'Notification' | 'Stop';

    try {
      const { config, session } = await createAudioEngine();
      
      // Setup cleanup on exit
      const cleanup = () => cleanupSession(session, config);
      process.on('exit', cleanup);
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
      
      let result;
      switch (eventType) {
        case 'Notification':
          result = await handleNotification(config, session);
          break;
        case 'Stop':
          result = await handleStop(config, session);
          break;
        default:
          result = await handleNotification(config, session);
          break;
      }
      
      const statusMessage = result.success 
        ? `Voice notification played via ${result.method} for ${eventType} event`
        : `Voice notification failed for ${eventType} event: ${result.error || 'Unknown error'}`;
      
      return context.success({
        messageForUser: statusMessage
      });
    } catch (error) {
      console.error(`Voice notification error: ${error}`);
      return context.success({});
    }
  }
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}