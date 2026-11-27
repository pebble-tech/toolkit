import { describe, expect, test } from 'vitest';

import { formatStampNotice, notifySlackOnCreate, postToSlack } from './index.js';

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

describe('formatStampNotice details', () => {
  const textOf = (notice: Parameters<typeof formatStampNotice>[0]) =>
    (formatStampNotice(notice).blocks as [{ text: { text: string } }])[0].text.text;

  test('given details, each present field gets a labelled line in the same block, after the note', () => {
    const message = formatStampNotice({
      ...base,
      note: 'hello',
      details: {
        name: 'Aisyah',
        company: 'Kedai Kopi',
        email: 'a@kopi.my',
        phone: '+60 12-345 6789',
        business: 'Coffee',
        stuck: 'Getting found online',
        tried: 'Instagram',
        links: ['https://kopi.my', 'https://instagram.com/kopi'],
      },
    });
    expect(message.blocks).toHaveLength(1);
    expect(
      textOf({
        ...base,
        note: 'hello',
        details: {
          name: 'Aisyah',
          company: 'Kedai Kopi',
          email: 'a@kopi.my',
          phone: '+60 12-345 6789',
          business: 'Coffee',
          stuck: 'Getting found online',
          tried: 'Instagram',
          links: ['https://kopi.my', 'https://instagram.com/kopi'],
        },
      })
        .split('\n')
        .slice(1, -1)
    ).toEqual([
      '> hello',
      '*Name:* Aisyah',
      '*Company:* Kedai Kopi',
      '*Email:* a@kopi.my',
      '*Phone:* +60 12-345 6789',
      '*Business:* Coffee',
      '*Stuck on:* Getting found online',
      '*Tried:* Instagram',
      '*Links:* https://kopi.my https://instagram.com/kopi',
    ]);
  });

  test('missing details, or only some fields, adds only what is there', () => {
    for (const details of [undefined, null, {}, { name: '  ', links: [] }]) {
      expect(textOf({ ...base, details }).split('\n')).toHaveLength(2);
    }
    expect(textOf({ ...base, details: { email: 'x@y.my' } }).split('\n')[1]).toBe('*Email:* x@y.my');
  });

  test('mentions and link markup in any field stay inert text', () => {
    const attack = '<!channel> <!here|here> <@U123> @channel @here @everyone <https://evil.example|bank> & co';
    // Everything but the footer, which holds our own album and remove links.
    const text = textOf({ ...base, note: attack, details: { name: attack, links: attack } })
      .split('\n')
      .slice(0, -1)
      .join('\n');
    expect(text).not.toMatch(/<[!@]/);
    expect(text).not.toMatch(/<https?:/);
    expect(text).not.toMatch(/@(channel|here|everyone)/);
    expect(text).toContain(
      '*Name:* &lt;!channel&gt; &lt;!here|here&gt; &lt;@U123&gt; @\u200bchannel @\u200bhere @\u200beveryone &lt;https://evil.example|bank&gt; &amp; co'
    );
  });

  test("long fields are cut, and the block stays within Slack's 3000-character section limit with its footer", () => {
    const long = 'x'.repeat(5000);
    const text = textOf({
      ...base,
      note: long,
      details: Object.fromEntries(
        ['name', 'company', 'email', 'phone', 'business', 'stuck', 'tried', 'links'].map((key) => [key, long])
      ),
    });
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).toContain(`*Name:* ${'x'.repeat(299)}…`);
    expect(text.split('\n').at(-1)).toMatch(/^:clock3: .*\|remove>$/);
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

test('a message builder that throws is logged and the create still succeeds', async () => {
  const logged: unknown[] = [];
  const hook = notifySlackOnCreate(() => {
    throw new Error('no count yet');
  });
  // Payload's request as the hook sees it: only its logger is used here.
  const req = { payload: { logger: { error: (...args: unknown[]) => logged.push(args) } } };
  const doc = { id: 1 };
  await expect(hook({ doc, operation: 'create', req } as never)).resolves.toBe(doc);
  expect(logged).toHaveLength(1);
});

describe('notifySlackOnCreate', () => {
  function hookWorld() {
    const logged: unknown[] = [];
    const posted: unknown[] = [];
    // Slack is faked at its boundary (fetch); of Payload's request the hook uses only the logger.
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response('ok');
    }) as typeof globalThis.fetch;
    const req = { payload: { logger: { error: (...args: unknown[]) => logged.push(args) } } };
    return { logged, posted, req, options: { webhookUrl: 'https://hooks.slack.com/services/T/B/x', fetch } };
  }

  test('an async builder is awaited and its message posted', async () => {
    const world = hookWorld();
    const hook = notifySlackOnCreate(async (doc) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return `stamp ${String(doc.id)} of 7`;
    }, world.options);
    const doc = { id: 3 };
    await expect(hook({ doc, operation: 'create', req: world.req } as never)).resolves.toBe(doc);
    expect(world.posted).toEqual([{ text: 'stamp 3 of 7' }]);
    expect(world.logged).toEqual([]);
  });

  test('a builder that rejects is logged and the create still succeeds', async () => {
    const world = hookWorld();
    const hook = notifySlackOnCreate(async () => {
      throw new Error('postcard lookup failed');
    }, world.options);
    const doc = { id: 4 };
    await expect(hook({ doc, operation: 'create', req: world.req } as never)).resolves.toBe(doc);
    expect(world.posted).toEqual([]);
    expect(world.logged).toHaveLength(1);
  });

  test('a sync builder still posts, an async null posts nothing, and an update never posts', async () => {
    const world = hookWorld();
    const doc = { id: 5 };
    await notifySlackOnCreate(() => 'sync', world.options)({ doc, operation: 'create', req: world.req } as never);
    await notifySlackOnCreate(async () => null, world.options)({ doc, operation: 'create', req: world.req } as never);
    await notifySlackOnCreate(() => 'update', world.options)({ doc, operation: 'update', req: world.req } as never);
    expect(world.posted).toEqual([{ text: 'sync' }]);
  });
});
