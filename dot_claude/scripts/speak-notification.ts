#!/usr/bin/env -S bun run --silent

/**
 * CLI interface for Voice Notification
 * Standalone script for manual voice notification control
 * Usage: speak-notification.ts {Notification|Stop|Error} [custom_message]
 */

import { 
  createAudioEngine,
  handleNotification, 
  handleStop, 
  handleError,
  speakNotification,
  cleanupSession
} from '../lib/unified-audio-engine.ts';

async function main() {
  const args = process.argv.slice(2);
  const eventType = args[0];
  
  if (!eventType) {
    console.log('Usage: speak-notification.ts {Notification|Stop|Error} [custom_message]');
    process.exit(1);
  }

  const { config, session } = await createAudioEngine();
  
  // Setup cleanup on exit
  const cleanup = () => cleanupSession(session, config);
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  switch (eventType) {
    case 'Notification':
      await handleNotification(config, session);
      break;
    case 'Stop':
      await handleStop(config, session);
      break;
    case 'Error':
      await handleError(config, session);
      break;
    default:
      if (args.length === 2 && args[1]) {
        await speakNotification(args[1], eventType, config, session);
      } else {
        console.log('Usage: speak-notification.ts {Notification|Stop|Error} [custom_message]');
        process.exit(1);
      }
      break;
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}