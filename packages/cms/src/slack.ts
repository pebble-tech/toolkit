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
