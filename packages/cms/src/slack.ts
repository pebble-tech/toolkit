import type { CollectionAfterChangeHook, PayloadRequest } from 'payload';

export interface SlackMessage {
  text: string;
  blocks?: unknown[];
}

export interface SlackOptions {
  /** A Slack incoming webhook URL. Default: `SLACK_WEBHOOK_URL`. Unset means post nowhere. */
  webhookUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Posts a message to a Slack incoming webhook. Returns false, sending nothing, when no webhook is configured (staging
 * may post nowhere); throws when the URL is not a Slack webhook or Slack does not answer 2xx.
 */
export async function postToSlack(message: SlackMessage | string, options: SlackOptions = {}): Promise<boolean> {
  const webhookUrl = options.webhookUrl ?? process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return false;
  if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
    throw new Error('SLACK_WEBHOOK_URL must be a https://hooks.slack.com/ incoming webhook');
  }
  const body = typeof message === 'string' ? { text: message } : message;
  const response = await (options.fetch ?? globalThis.fetch)(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Slack answered ${response.status}`);
  return true;
}

/**
 * An afterChange hook that posts `message(doc)` to Slack when a document is created, for submissions such as stamps or
 * contact forms. A Slack failure is logged and never fails the create.
 */
export function notifySlackOnCreate(
  message: (doc: Record<string, unknown>, req: PayloadRequest) => SlackMessage | string | null,
  options: SlackOptions = {}
): CollectionAfterChangeHook {
  return async ({ doc, operation, req }) => {
    if (operation !== 'create') return doc;
    const built = message(doc, req);
    if (built) {
      try {
        await postToSlack(built, options);
      } catch (error) {
        req.payload.logger.error({ err: error }, 'Slack notification failed');
      }
    }
    return doc;
  };
}

export interface StampNotice {
  /** Public URL of the stamp PNG. */
  stampUrl: string;
  note?: string | null;
  /** The stamp's running number, for "Stamp #N". */
  count: number;
  createdAt: Date | string;
  albumUrl: string;
  /** The stamp in the CMS admin, where it can be deleted. */
  removeUrl: string;
  /** `prod` (or `production`) posts untagged; any other stage, such as `staging`, is tagged `[staging]`. */
  stage: string;
  /** What the sender told us about themselves, shown under the note when present. Every field is optional. */
  details?: StampDetails | null;
}

export interface StampDetails {
  name?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  business?: string | null;
  stuck?: string | null;
  tried?: string | null;
  links?: string | string[] | null;
}

const DETAIL_LABELS: [keyof StampDetails, string][] = [
  ['name', 'Name'],
  ['company', 'Company'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['business', 'Business'],
  ['stuck', 'Stuck on'],
  ['tried', 'Tried'],
  ['links', 'Links'],
];
const MAX_DETAIL_LENGTH = 300;
/** Slack's limit for a section block's text. */
const MAX_SECTION_TEXT = 3000;

const MAX_NOTE_LENGTH = 500;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Visitor text made inert for Slack mrkdwn: `&`, `<` and `>` are escaped, so `<!channel>`, `<@U123>` and `<url|text>`
 * stay literal, and a zero-width space after `@` keeps `@channel`, `@here` and `@everyone` from notifying anyone.
 */
function inert(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/@(channel|here|everyone)\b/gi, '@\u200b$1');
}

/** `28 Nov 2026, 00:30 MYT`: the time in Asia/Kuala_Lumpur, built from parts so it reads the same on every Node. */
function malaysiaTime(at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  );
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} MYT`;
}

// The headline and footer always fit; the visitor's part is cut so the whole stays within Slack's section limit.
function sectionText(headline: string, middle: string, footer: string): string {
  const room = MAX_SECTION_TEXT - headline.length - footer.length - 2;
  return [headline, middle ? truncate(middle, room - 1) : '', footer].filter(Boolean).join('\n');
}

/**
 * The Slack message for a new stamp: one Block Kit section that reads like a postcard arriving, with the stamp as
 * its image, the sender's note quoted and their details when given, the running count, the time in Malaysia, a link to the album
 * and a small link to remove it in the CMS. Pure, so a hook builds it with `notifySlackOnCreate`.
 */
export function formatStampNotice(notice: StampNotice): SlackMessage {
  const tag = ['prod', 'production'].includes(notice.stage) ? '' : `[${notice.stage}] `;
  const headline = `${tag}:love_letter: *A postcard just landed!* Stamp #${notice.count}`;
  const note = notice.note?.trim();
  const quoted = note
    ? inert(truncate(note, MAX_NOTE_LENGTH))
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    : undefined;
  const details = DETAIL_LABELS.flatMap(([key, label]) => {
    const raw = notice.details?.[key];
    const value = (Array.isArray(raw) ? raw.join(' ') : (raw ?? '')).replace(/\s+/g, ' ').trim();
    return value ? [`*${label}:* ${inert(truncate(value, MAX_DETAIL_LENGTH))}`] : [];
  });
  const footer = `:clock3: ${malaysiaTime(new Date(notice.createdAt))} · <${notice.albumUrl}|See the album> · <${notice.removeUrl}|remove>`;
  return {
    text: `${tag}A postcard just landed! Stamp #${notice.count}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: sectionText(headline, [quoted, ...details].filter(Boolean).join('\n'), footer) },
        accessory: { type: 'image', image_url: notice.stampUrl, alt_text: `Stamp #${notice.count}` },
      },
    ],
  };
}
