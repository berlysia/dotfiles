#!/usr/bin/env -S bun run --silent

/**
 * Voice Notification Hook
 * cc-hooks-ts hook for Notification and Stop events using shared library
 */

import { defineHook } from "cc-hooks-ts";
import { 
  createVoiceConfig, 
  createVoiceSession, 
  handleNotification, 
  handleStop,
  cleanupSession
} from '../../lib/voice-notification.ts';
const hook = defineHook({
  trigger: {
    Notification: true,
    Stop: true
  },
  run: async (context) => {
    const eventType = context.input.hook_event_name as 'Notification' | 'Stop';

    try {
      const config = createVoiceConfig();
      const session = createVoiceSession(config);
      
      // Setup cleanup on exit
      const cleanup = () => cleanupSession(session, config);
      process.on('exit', cleanup);
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
      
      switch (eventType) {
        case 'Notification':
          await handleNotification(config, session);
          break;
        case 'Stop':
          await handleStop(config, session);
          break;
        default:
          await handleNotification(config, session);
          break;
      }
      
      return context.success({
        messageForUser: `Voice notification played for ${eventType} event`
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