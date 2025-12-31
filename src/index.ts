/**
 * Device Activity Tracker - CLI Interface
 *
 * This is a proof-of-concept tool demonstrating privacy vulnerabilities
 * in messaging apps (in this case WhatsApp) through RTT-based activity analysis.
 *
 * For educational and research purposes only.
 */

const debugMode = process.argv.includes('--debug') || process.argv.includes('-d');
const originalConsoleLog = console.log;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

// prevents Baileys from spamming the console
const shouldSuppressOutput = (message: string): boolean => {
    return message.includes('Closing session:') ||
           message.includes('SessionEntry') ||
           message.includes('_chains') ||
           message.includes('registrationId') ||
           message.includes('currentRatchet') ||
           message.includes('ephemeralKeyPair') ||
           message.includes('pendingPreKey') ||
           message.includes('indexInfo') ||
           message.includes('baseKey') ||
           message.includes('remoteIdentityKey') ||
           message.includes('lastRemoteEphemeralKey') ||
           message.includes('previousCounter') ||
           message.includes('rootKey') ||
           message.includes('signedKeyId') ||
           message.includes('preKeyId') ||
           message.includes('<Buffer');
};

if (!debugMode) {
    // Override console.log
    console.log = (...args: any[]) => {
        const message = String(args[0] || '');
        if (!shouldSuppressOutput(message)) {
            originalConsoleLog(...args);
        }
    };

    // Override process.stdout.write to catch low-level output
    process.stdout.write = ((chunk: any, encoding?: any, callback?: any): boolean => {
        const message = String(chunk);
        if (shouldSuppressOutput(message)) {
            // Suppress - but still call callback if provided
            if (typeof encoding === 'function') {
                encoding();
            } else if (typeof callback === 'function') {
                callback();
            }
            return true;
        }
        return originalStdoutWrite(chunk, encoding, callback);
    }) as typeof process.stdout.write;
}

// Now safe to import modules
import '@whiskeysockets/baileys';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { WhatsAppTracker } from './tracker.js';
import * as readline from 'readline';
import { createTelegrafReporterFromEnv } from './telegraf.js';

if (debugMode) {
    originalConsoleLog('🔍 Debug mode enabled\n');
} else {
    originalConsoleLog('📊 Normal mode (important outputs only)\n');
    originalConsoleLog('💡 Tip: Use --debug or -d for detailed debug output\n');
}

const trackedTargetJids: Set<string> = new Set();
const activeTrackers: Map<string, WhatsAppTracker> = new Map();
const telegrafReporter = createTelegrafReporterFromEnv();
const probeDelayOptions = parseProbeDelayOptions(process.argv);
const initialTargets = parseTargetsFromArgs(process.argv);

function parseProbeDelayOptions(args: string[]): { minProbeDelayMs?: number; maxProbeDelayMs?: number } | undefined {
    const intervalArg = getArgValue(args, '--probe-interval-ms');
    const minArg = getArgValue(args, '--probe-min-ms');
    const maxArg = getArgValue(args, '--probe-max-ms');

    let minProbeDelayMs: number | undefined;
    let maxProbeDelayMs: number | undefined;

    if (intervalArg !== undefined) {
        const interval = parsePositiveNumber(intervalArg);
        if (interval !== undefined) {
            minProbeDelayMs = interval;
            maxProbeDelayMs = interval;
        } else {
            originalConsoleLog('⚠️ Invalid --probe-interval-ms value, ignoring.');
        }
    }

    if (minArg !== undefined) {
        const minValue = parsePositiveNumber(minArg);
        if (minValue !== undefined) {
            minProbeDelayMs = minValue;
        } else {
            originalConsoleLog('⚠️ Invalid --probe-min-ms value, ignoring.');
        }
    }

    if (maxArg !== undefined) {
        const maxValue = parsePositiveNumber(maxArg);
        if (maxValue !== undefined) {
            maxProbeDelayMs = maxValue;
        } else {
            originalConsoleLog('⚠️ Invalid --probe-max-ms value, ignoring.');
        }
    }

    if (minProbeDelayMs === undefined && maxProbeDelayMs === undefined) {
        return undefined;
    }

    return { minProbeDelayMs, maxProbeDelayMs };
}

function getArgValue(args: string[], key: string): string | undefined {
    const index = args.indexOf(key);
    if (index === -1 || index === args.length - 1) return undefined;
    return args[index + 1];
}

function parsePositiveNumber(value: string): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return Math.floor(parsed);
}

function parseTargetsFromArgs(args: string[]): string[] {
    const targetsArg = getArgValue(args, '--targets');
    if (!targetsArg) return [];

    return targetsArg
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: true,
    });

    originalConsoleLog('🔌 Connecting to WhatsApp... (use the --debug flag for more details)');

    let isConnected = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isConnected = false;
            // Stop the tracker if it's running, as the socket is dead
            for (const tracker of activeTrackers.values()) {
                tracker.stopTracking();
            }
            activeTrackers.clear();

            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (debugMode) {
                originalConsoleLog('connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            }
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            originalConsoleLog('✅ Connected to WhatsApp');
            isConnected = true;

            if (trackedTargetJids.size > 0) {
                if (debugMode) {
                    originalConsoleLog(`Resuming tracking for ${Array.from(trackedTargetJids).join(', ')}...`);
                }
                for (const jid of trackedTargetJids) {
                    const tracker = new WhatsAppTracker(sock, jid, debugMode, probeDelayOptions);
                    tracker.onUpdate = (updateData) => {
                        telegrafReporter?.reportTrackerUpdate({
                            contactId: jid,
                            platform: 'whatsapp',
                            ...updateData
                        });
                    };
                    tracker.startTracking();
                    activeTrackers.set(jid, tracker);
                }
            } else if (initialTargets.length > 0) {
                const startedAny = await startTrackingForNumbers(initialTargets);
                if (!startedAny && trackedTargetJids.size === 0) {
                    askForTarget();
                }
            } else {
                askForTarget();
            }
        } else {
            if (debugMode) {
                originalConsoleLog('connection update', update);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    const startTrackingForNumbers = async (rawNumbers: string[]) => {
        if (rawNumbers.length === 0) {
            return false;
        }

        const validTargets: string[] = [];
        const invalidNumbers: string[] = [];

        for (const raw of rawNumbers) {
            const cleanNumber = raw.replace(/\D/g, '');
            if (cleanNumber.length < 10) {
                invalidNumbers.push(raw);
                continue;
            }
            validTargets.push(cleanNumber + '@s.whatsapp.net');
        }

        if (validTargets.length === 0) {
            return false;
        }

        if (invalidNumbers.length > 0) {
            originalConsoleLog(`⚠️ Skipping invalid entries: ${invalidNumbers.join(', ')}`);
        }

        let startedAny = false;

        for (const targetJid of validTargets) {
            if (trackedTargetJids.has(targetJid)) {
                originalConsoleLog(`ℹ️ Already tracking ${targetJid}`);
                continue;
            }

            if (debugMode) {
                originalConsoleLog(`Verifying ${targetJid}...`);
            }
            try {
                const results = await sock.onWhatsApp(targetJid);
                const result = results?.[0];

                if (result?.exists) {
                    trackedTargetJids.add(result.jid);
                    const tracker = new WhatsAppTracker(sock, result.jid, debugMode, probeDelayOptions);
                    tracker.onUpdate = (updateData) => {
                        telegrafReporter?.reportTrackerUpdate({
                            contactId: result.jid,
                            platform: 'whatsapp',
                            ...updateData
                        });
                    };
                    tracker.startTracking();
                    activeTrackers.set(result.jid, tracker);
                    startedAny = true;
                    originalConsoleLog(`✅ Tracking started for ${result.jid}`);
                } else {
                    originalConsoleLog(`❌ Number not registered on WhatsApp: ${targetJid}`);
                }
            } catch (err) {
                console.error(`Error verifying ${targetJid}:`, err);
            }
        }

        return startedAny;
    };

    const askForTarget = () => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question('Enter target phone numbers (comma-separated, e.g., 491701234567, 491701234568): ', async (numberInput) => {
            const rawNumbers = numberInput
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);
            const startedAny = await startTrackingForNumbers(rawNumbers);
            rl.close();
            if (!startedAny && trackedTargetJids.size === 0) {
                askForTarget();
            }
        });
    };
}

connectToWhatsApp();

process.on('SIGINT', () => {
    telegrafReporter?.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    telegrafReporter?.close();
    process.exit(0);
});
