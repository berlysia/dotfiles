#!/usr/bin/env bun

/**
 * Claude Notification Sound Player - TypeScript Version
 * Auto-detects platform and plays notification sounds
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface NotificationLogEntry {
    timestamp: string;
    event_type: string;
    message: string;
    sound_type: string;
}

type EventType = 'Notification' | 'Stop' | 'stats';
type SoundType = 'Permission' | 'Waiting' | 'Notification' | 'Stop';
type Platform = 'darwin' | 'wsl' | 'linux';

class NotificationSoundPlayer {
    private logDir: string;
    private logFile: string;
    private maxLines: number = 1000;

    constructor() {
        this.logDir = path.join(process.env.HOME || '', '.claude/hooks/logs');
        this.logFile = path.join(this.logDir, 'notifications.jsonl');
    }

    /**
     * Ensure log directory exists
     */
    ensureLogDir(): void {
        try {
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }
        } catch (error) {
            // Silently continue if directory creation fails
        }
    }

    /**
     * Log notification message with metadata
     */
    logNotification(eventType: EventType, message: string, soundType: SoundType): void {
        this.ensureLogDir();
        
        const logEntry: NotificationLogEntry = {
            timestamp: new Date().toISOString(),
            event_type: eventType,
            message: message,
            sound_type: soundType
        };

        try {
            const logData = JSON.stringify(logEntry) + '\n';
            fs.appendFileSync(this.logFile, logData);
            this.rotateLogIfNeeded();
        } catch (error) {
            // Silently continue if logging fails
        }
    }

    /**
     * Rotate log file if it exceeds threshold
     */
    rotateLogIfNeeded(): void {
        try {
            if (!fs.existsSync(this.logFile)) {
                return;
            }

            const content = fs.readFileSync(this.logFile, 'utf-8');
            const lineCount = content.split('\n').length;

            if (lineCount > this.maxLines) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const backupFile = `${this.logFile}.${timestamp}`;
                
                fs.renameSync(this.logFile, backupFile);

                // Keep only last 5 backup files
                this.cleanOldBackups();
            }
        } catch (error) {
            // Silently continue if rotation fails
        }
    }

    /**
     * Clean old backup files
     */
    cleanOldBackups(): void {
        try {
            const files = fs.readdirSync(this.logDir)
                .filter(file => file.startsWith('notifications.jsonl.'))
                .map(file => ({
                    name: file,
                    path: path.join(this.logDir, file),
                    mtime: fs.statSync(path.join(this.logDir, file)).mtime
                }))
                .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

            // Remove files beyond the last 5
            files.slice(5).forEach(file => {
                try {
                    fs.unlinkSync(file.path);
                } catch (error) {
                    // Continue if deletion fails
                }
            });
        } catch (error) {
            // Silently continue if cleanup fails
        }
    }

    /**
     * Parse JSON input and extract message
     */
    parseNotificationMessage(): string {
        try {
            // Check if stdin has data
            if (process.stdin.isTTY) {
                return '';
            }

            // Read from stdin synchronously for simplicity
            const input = fs.readFileSync(process.stdin.fd, 'utf-8').trim();
            
            if (!input) {
                return '';
            }

            const data = JSON.parse(input);
            return data.message || '';
        } catch (error) {
            return '';
        }
    }

    /**
     * Determine sound type based on message content
     */
    determineSoundType(message: string, eventType: EventType): SoundType {
        if (!message) {
            return eventType as SoundType;
        }

        // Pattern matching based on actual notification messages
        if (message.includes('needs your permission to use')) {
            return 'Permission';
        }
        
        if (message.includes('is waiting for your input') || message.includes('has been idle')) {
            return 'Waiting';
        }

        // Default to event type for other messages
        return eventType as SoundType;
    }

    /**
     * Detect current platform
     */
    detectPlatform(): Platform {
        const osType = process.env.OSTYPE || '';
        
        if (osType.startsWith('darwin')) {
            return 'darwin';
        }
        
        if (process.env.WSL_DISTRO_NAME || osType === 'msys') {
            return 'wsl';
        }
        
        return 'linux';
    }

    /**
     * Get sound file paths for platform
     */
    getSoundPaths(soundType: SoundType, platform: Platform): { prefix: string; sound: string; command: string } {
        const homeDir = process.env.HOME || '';
        
        switch (platform) {
            case 'darwin':
                return {
                    prefix: path.join(homeDir, '.claude/hooks/sounds/Prefix.wav'),
                    sound: this.getSoundFilePath(homeDir, soundType, 'darwin'),
                    command: 'afplay'
                };
                
            case 'wsl':
                const userDir = process.env.USER || '';
                return {
                    prefix: `C:\\Users\\${userDir}\\.claude\\sounds\\Prefix.wav`,
                    sound: this.getSoundFilePath(`C:\\Users\\${userDir}`, soundType, 'wsl'),
                    command: 'powershell.exe'
                };
                
            case 'linux':
            default:
                return {
                    prefix: path.join(homeDir, '.claude/hooks/sounds/Prefix.wav'),
                    sound: this.getSoundFilePath(homeDir, soundType, 'linux'),
                    command: 'paplay'
                };
        }
    }

    /**
     * Get sound file path with fallback
     */
    getSoundFilePath(baseDir: string, soundType: SoundType, platform: Platform): string {
        const soundDir = platform === 'wsl' ? `${baseDir}\\.claude\\sounds` : path.join(baseDir, '.claude/hooks/sounds');
        const primaryFile = platform === 'wsl' ? `${soundDir}\\Claude${soundType}.wav` : path.join(soundDir, `Claude${soundType}.wav`);
        const fallbackFile = platform === 'wsl' ? `${soundDir}\\ClaudeNotification.wav` : path.join(soundDir, 'ClaudeNotification.wav');

        // For non-WSL platforms, check file existence
        if (platform !== 'wsl') {
            return fs.existsSync(primaryFile) ? primaryFile : fallbackFile;
        }

        // For WSL, assume primary file exists (checking via PowerShell would be slow)
        return primaryFile;
    }

    /**
     * Check if command exists
     */
    commandExists(command: string): boolean {
        try {
            execSync(`which ${command}`, { stdio: 'ignore' });
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Play sound on macOS
     */
    async playMacOSSound(prefixFile: string, soundFile: string): Promise<void> {
        if (!this.commandExists('afplay')) {
            console.error('Error: afplay is not installed. afplay should be pre-installed on macOS');
            return;
        }

        try {
            // Play prefix sound if exists
            if (fs.existsSync(prefixFile)) {
                execSync(`afplay "${prefixFile}"`, { stdio: 'ignore' });
            }

            // Play main sound
            execSync(`afplay "${soundFile}"`, { stdio: 'ignore' });
        } catch (error) {
            console.error(`Sound file not found: ${soundFile}`);
        }
    }

    /**
     * Play sound on Linux
     */
    async playLinuxSound(prefixFile: string, soundFile: string): Promise<void> {
        let player = '';
        
        if (this.commandExists('paplay')) {
            player = 'paplay';
        } else if (this.commandExists('aplay')) {
            player = 'aplay -q';
        } else {
            console.error('Error: No audio player found. Install with: sudo apt-get install pulseaudio-utils');
            return;
        }

        try {
            // Play prefix sound if exists
            if (fs.existsSync(prefixFile)) {
                execSync(`${player} "${prefixFile}"`, { stdio: 'ignore' });
            }

            // Play main sound
            execSync(`${player} "${soundFile}"`, { stdio: 'ignore' });
        } catch (error) {
            console.error(`Sound file not found: ${soundFile}`);
        }
    }

    /**
     * Play sound on WSL (Windows)
     */
    async playWSLSound(prefixFile: string, soundFile: string): Promise<void> {
        try {
            const script = `
                try {
                    # Play prefix sound if exists
                    if (Test-Path '${prefixFile}') {
                        $prefixPlayer = New-Object Media.SoundPlayer '${prefixFile}'
                        $prefixPlayer.PlaySync()
                    }
                    
                    # Play main sound
                    $player = New-Object Media.SoundPlayer '${soundFile}'
                    $player.PlaySync()
                    Write-Host 'Sound played successfully'
                } catch {
                    Write-Host "Error playing sound: $($_.Exception.Message)"
                }
            `;

            execSync(`powershell.exe -c "${script}"`, { stdio: 'ignore' });
        } catch (error) {
            console.error(`Sound file not found: ${soundFile}`);
        }
    }

    /**
     * Play sound based on platform
     */
    async playSound(soundType: SoundType): Promise<void> {
        const platform = this.detectPlatform();
        const { prefix, sound, command } = this.getSoundPaths(soundType, platform);

        try {
            switch (platform) {
                case 'darwin':
                    await this.playMacOSSound(prefix, sound);
                    break;
                case 'linux':
                    await this.playLinuxSound(prefix, sound);
                    break;
                case 'wsl':
                    await this.playWSLSound(prefix, sound);
                    break;
            }
        } catch (error) {
            console.error(`Failed to play sound: ${error}`);
        }
    }

    /**
     * Show notification statistics
     */
    showStats(): void {
        this.ensureLogDir();

        if (!fs.existsSync(this.logFile)) {
            console.log('No notification logs found.');
            return;
        }

        try {
            const content = fs.readFileSync(this.logFile, 'utf-8');
            const lines = content.trim().split('\n').filter(line => line);
            
            console.log('=== Claude Notification Statistics ===');
            console.log(`Total notifications: ${lines.length}`);
            console.log('');

            // Parse entries for statistics
            const entries = lines.map(line => {
                try {
                    return JSON.parse(line) as NotificationLogEntry;
                } catch {
                    return null;
                }
            }).filter(entry => entry !== null) as NotificationLogEntry[];

            // Event type statistics
            const eventTypes = new Map<string, number>();
            const soundTypes = new Map<string, number>();

            entries.forEach(entry => {
                eventTypes.set(entry.event_type, (eventTypes.get(entry.event_type) || 0) + 1);
                soundTypes.set(entry.sound_type, (soundTypes.get(entry.sound_type) || 0) + 1);
            });

            console.log('By event type:');
            Array.from(eventTypes.entries())
                .sort(([,a], [,b]) => b - a)
                .forEach(([type, count]) => {
                    console.log(`${count.toString().padStart(6)} ${type}`);
                });

            console.log('');
            console.log('By sound type:');
            Array.from(soundTypes.entries())
                .sort(([,a], [,b]) => b - a)
                .forEach(([type, count]) => {
                    console.log(`${count.toString().padStart(6)} ${type}`);
                });

            console.log('');
            console.log('Recent messages (last 10):');
            entries.slice(-10).forEach(entry => {
                console.log(`[${entry.timestamp}] ${entry.event_type}: ${entry.message}`);
            });

        } catch (error) {
            console.error(`Error reading log file: ${error}`);
        }
    }

    /**
     * Handle notification event
     */
    async handleNotification(): Promise<void> {
        const notificationMessage = this.parseNotificationMessage();
        const soundType = this.determineSoundType(notificationMessage, 'Notification');
        
        this.logNotification('Notification', notificationMessage, soundType);
        await this.playSound(soundType);
    }

    /**
     * Handle stop event
     */
    async handleStop(): Promise<void> {
        this.logNotification('Stop', '', 'Stop');
        await this.playSound('Stop');
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    const eventType = args[0] as EventType;
    
    const player = new NotificationSoundPlayer();

    switch (eventType) {
        case 'Notification':
            await player.handleNotification();
            break;
        case 'Stop':
            await player.handleStop();
            break;
        case 'stats':
            player.showStats();
            break;
        default:
            console.log('Usage: play-notification-sound.ts {Notification|Stop|stats}');
            process.exit(1);
    }
}

// Execute if run directly
if (require.main === module) {
    main().catch(error => {
        console.error('Error:', error);
        process.exit(1);
    });
}

export { NotificationSoundPlayer };
export type { NotificationLogEntry, EventType, SoundType, Platform };