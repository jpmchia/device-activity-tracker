import dgram from 'dgram';

type Platform = 'whatsapp' | 'signal';

interface TrackerDevice {
    jid: string;
    state: string;
    rtt: number;
    avg: number;
}

interface TrackerUpdate {
    contactId: string;
    platform: Platform;
    devices: TrackerDevice[];
    deviceCount: number;
    presence: string | null;
    median: number;
    threshold: number;
}

interface TelegrafConfig {
    protocol: 'udp' | 'http';
    host: string;
    port: number;
    url: string | null;
    httpPath: string;
    enabled: boolean;
    debug: boolean;
}

class TelegrafReporter {
    private config: TelegrafConfig;
    private udpSocket: dgram.Socket | null = null;

    constructor(config: TelegrafConfig) {
        this.config = config;
        if (this.config.protocol === 'udp') {
            this.udpSocket = dgram.createSocket('udp4');
        }
    }

    public reportTrackerUpdate(update: TrackerUpdate) {
        if (!this.config.enabled) return;

        const lines = buildLineProtocolLines(update);
        if (lines.length === 0) return;

        const payload = lines.join('\n');
        if (this.config.debug) {
            console.log(`[TELEGRAF] Sending ${lines.length} line(s) via ${this.config.protocol}`);
        }

        if (this.config.protocol === 'http') {
            this.sendHttp(payload);
        } else {
            this.sendUdp(payload);
        }
    }

    private sendUdp(payload: string) {
        if (!this.udpSocket) return;
        if (this.config.debug) {
            console.log(`[TELEGRAF] UDP -> ${this.config.host}:${this.config.port}`);
            console.log(payload);
        }
        this.udpSocket.send(payload, this.config.port, this.config.host, (err) => {
            if (err && this.config.debug) {
                console.log('[TELEGRAF] UDP send error:', err);
            }
        });
    }

    private async sendHttp(payload: string) {
        const url = this.config.url || `http://${this.config.host}:${this.config.port}${this.config.httpPath}`;
        try {
            if (this.config.debug) {
                console.log(`[TELEGRAF] HTTP -> ${url}`);
                console.log(payload);
            }
            await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain'
                },
                body: payload
            });
        } catch (err) {
            if (this.config.debug) {
                console.log('[TELEGRAF] HTTP send error:', err);
            }
        }
    }

    public close() {
        if (this.udpSocket) {
            this.udpSocket.close();
            this.udpSocket = null;
        }
    }
}

function buildLineProtocolLines(update: TrackerUpdate): string[] {
    const timestamp = Date.now() * 1_000_000;
    const lines: string[] = [];

    for (const device of update.devices) {
        const tags = {
            platform: update.platform,
            contact_id: update.contactId,
            device_id: device.jid,
            state: device.state
        };

        const fields = {
            rtt_ms: device.rtt,
            avg_rtt_ms: device.avg,
            threshold_ms: update.threshold,
            status: device.state
        };

        const line = buildLine('device_activity', tags, fields, timestamp);
        if (line) {
            lines.push(line);
        }
    }

    const summaryFields: Record<string, number | string> = {
        median_ms: update.median,
        threshold_ms: update.threshold,
        device_count: update.deviceCount
    };

    if (update.presence) {
        summaryFields.presence = update.presence;
    }

    const summaryLine = buildLine(
        'device_activity_summary',
        { platform: update.platform, contact_id: update.contactId },
        summaryFields,
        timestamp
    );

    if (summaryLine) {
        lines.push(summaryLine);
    }

    return lines;
}

function buildLine(
    measurement: string,
    tags: Record<string, string>,
    fields: Record<string, number | string | boolean>,
    timestamp: number
): string | null {
    const tagParts = Object.entries(tags)
        .filter(([, value]) => value !== '')
        .map(([key, value]) => `${escapeKey(key)}=${escapeTagValue(value)}`);

    const fieldParts = Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${escapeKey(key)}=${formatFieldValue(value)}`)
        .filter((part) => !part.endsWith('='));

    if (fieldParts.length === 0) return null;

    const tagSection = tagParts.length > 0 ? `,${tagParts.join(',')}` : '';
    const fieldSection = fieldParts.join(',');
    return `${escapeMeasurement(measurement)}${tagSection} ${fieldSection} ${timestamp}`;
}

function escapeMeasurement(value: string): string {
    return value.replace(/([, ])/g, '\\$1');
}

function escapeKey(value: string): string {
    return value.replace(/([,= ])/g, '\\$1');
}

function escapeTagValue(value: string): string {
    return value.replace(/([,= ])/g, '\\$1');
}

function formatFieldValue(value: number | string | boolean): string {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return '';
        return value.toString();
    }

    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }

    return `"${escapeFieldString(value)}"`;
}

function escapeFieldString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseBool(value: string | undefined): boolean {
    if (!value) return false;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function createTelegrafReporterFromEnv(): TelegrafReporter | null {
    const enabled = parseBool(process.env.TELEGRAF_ENABLED) ||
        Boolean(process.env.TELEGRAF_URL) ||
        Boolean(process.env.TELEGRAF_HOST);

    if (!enabled) return null;

    const protocol = (process.env.TELEGRAF_PROTOCOL || (process.env.TELEGRAF_URL ? 'http' : 'udp')).toLowerCase();
    const host = process.env.TELEGRAF_HOST || '127.0.0.1';
    const httpPath = process.env.TELEGRAF_HTTP_PATH || '/telegraf';
    const port = Number(process.env.TELEGRAF_PORT) || (protocol === 'http' ? 8186 : 8094);
    const url = process.env.TELEGRAF_URL || null;
    const debug = parseBool(process.env.TELEGRAF_DEBUG);

    if (protocol !== 'http' && protocol !== 'udp') {
        console.log(`[TELEGRAF] Unsupported protocol: ${protocol}`);
        return null;
    }

    return new TelegrafReporter({
        protocol,
        host,
        port,
        url,
        httpPath,
        enabled: true,
        debug
    });
}
