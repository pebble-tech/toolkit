import { describe, expect, test } from 'vitest';

import { formatStampNotice, postToSlack } from './index.js';

const base = {
  stampUrl: 'https://media-pebbletech.pebbletech.my/stamps/s42.png',
  count: 42,
  createdAt: '2026-11-27T02:05:00Z',
  albumUrl: 'https://pebbletech.my/unstuck#album',
  removeUrl: 'https://cms-pebbletech.pebbletech.my/admin/collections/stamps/42',
  stage: 'prod',
};

describe('formatStampNotice', () => {
  test('with a note: one section with the stamp image, the quoted note, count, Malaysia time, album and remove links', () => {
    expect(formatStampNotice({ ...base, note: 'Keep going!\nYou got this' })).toEqual({
      text: 'A postcard just landed! Stamp #42',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              ':love_letter: *A postcard just landed!* Stamp #42',
              '> Keep going!',
              '> You got this',
              ':clock3: 27 Nov 2026, 10:05 MYT · <https://pebbletech.my/unstuck#album|See the album> · <https://cms-pebbletech.pebbletech.my/admin/collections/stamps/42|remove>',
            ].join('\n'),
          },
          accessory: { type: 'image', image_url: base.stampUrl, alt_text: 'Stamp #42' },
        },
      ],
    });
  });

  test('without a note (absent, null or blank) there is no quote line', () => {
    for (const note of [undefined, null, '   ']) {
      const [block] = formatStampNotice({ ...base, note }).blocks as [{ text: { text: string } }];
      expect(block.text.text.split('\n')).toEqual([
        ':love_letter: *A postcard just landed!* Stamp #42',
        expect.stringMatching(/^:clock3: 27 Nov 2026, 10:05 MYT · /),
      ]);
    }
  });

  test('staging has the same shape with a [staging] tag', () => {
    const message = formatStampNotice({ ...base, stage: 'staging' });
    const [block] = message.blocks as [{ text: { text: string } }];
    expect(message.text).toBe('[staging] A postcard just landed! Stamp #42');
    expect(block.text.text.startsWith('[staging] :love_letter: *A postcard just landed!* Stamp #42\n')).toBe(true);
    expect(message.blocks).toHaveLength(1);
  });

  test('the time is Malaysia time (UTC+8), which crosses midnight before UTC does', () => {
    const time = (createdAt: string) =>
      (formatStampNotice({ ...base, createdAt }).blocks as [{ text: { text: string } }])[0].text.text.match(
        /:clock3: ([^·]+) MYT/
      )?.[1];
    expect(time('2026-11-27T15:59:00Z')).toBe('27 Nov 2026, 23:59');
    expect(time('2026-11-27T16:00:00Z')).toBe('28 Nov 2026, 00:00');
    expect(time('2026-12-31T23:30:00Z')).toBe('1 Jan 2027, 07:30');
  });

  test("a visitor's note cannot make Slack links or mentions", () => {
    const [block] = formatStampNotice({ ...base, note: '<!channel> <https://evil.example|click> & co' }).blocks as [
      { text: { text: string } },
    ];
    expect(block.text.text).toContain('> &lt;!channel&gt; &lt;https://evil.example|click&gt; &amp; co');
  });
});

describe('postToSlack', () => {
  // Slack is the external service; the fake stands at its boundary, the fetch call.
  function fakeSlack(status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('ok', { status });
    };
    return { calls, fetch: fetch as typeof globalThis.fetch };
  }

  test('posts the message as JSON to the webhook', async () => {
    const slack = fakeSlack();
    const message = formatStampNotice(base);
    await expect(
      postToSlack(message, { webhookUrl: 'https://hooks.slack.com/services/T/B/x', fetch: slack.fetch })
    ).resolves.toBe(true);
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]?.url).toBe('https://hooks.slack.com/services/T/B/x');
    expect(JSON.parse(String(slack.calls[0]?.init.body))).toEqual(message);
  });

  test('with no webhook configured it sends nothing', async () => {
    const slack = fakeSlack();
    await expect(postToSlack('hi', { webhookUrl: '', fetch: slack.fetch })).resolves.toBe(false);
    expect(slack.calls).toEqual([]);
  });

  test('refuses a URL that is not a Slack webhook, and a non-2xx answer', async () => {
    const slack = fakeSlack(500);
    await expect(postToSlack('hi', { webhookUrl: 'https://evil.example/hook', fetch: slack.fetch })).rejects.toThrow(
      'hooks.slack.com'
    );
    await expect(
      postToSlack('hi', { webhookUrl: 'https://hooks.slack.com/services/x', fetch: slack.fetch })
    ).rejects.toThrow('Slack answered 500');
  });
});
