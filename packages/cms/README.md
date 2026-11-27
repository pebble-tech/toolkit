# @pebbletech/cms

The Payload CMS wiring every Pebble client site shares: the config, users and roles, media on R2, signed cache purge,
signed preview links, access helpers and a Slack notice for submissions. Collections, globals, migrations and the seed
stay in each client's `apps/cms`.

```sh
pnpm add @pebbletech/cms payload @payloadcms/db-postgres @payloadcms/storage-s3 @payloadcms/richtext-lexical
```

Node `>=24.22.3`. The Payload packages are peer dependencies, marked optional so that `apps/marketing` can install this
package for `@pebbletech/cms/site` without pulling Payload in. The main entry imports no Next.js.

| Entry | For | Imports |
|---|---|---|
| `@pebbletech/cms` | `apps/cms` | Payload and its adapters |
| `@pebbletech/cms/site` | `apps/marketing` and `@site/content`: verify a purge or preview link, cache tags | `node:crypto` only |

## Config

```ts
// apps/cms/src/payload.config.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCmsConfig } from '@pebbletech/cms';
import sharp from 'sharp';

import { Products } from './collections/Products';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default createCmsConfig({
  collections: [Products],
  locales: ['en', 'ms', 'zh'],
  importMapBaseDir: dirname,
  typesOutputFile: path.resolve(dirname, '../../../packages/content/src/payload-types.ts'),
  migrationDir: path.resolve(dirname, 'migrations'),
  sharp,
});
```

`createCmsConfig` returns Payload's `buildConfig` result with:

- Postgres on schema `cms` (`DATABASE_URL`, or `databaseUrl` and `pool`).
- R2 through `@payloadcms/storage-s3` with `clientUploads`: the browser gets a signed PUT URL and sends the file
  straight to R2. Settings come from `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (or the
  `storage` option). With `MEDIA_BASE_URL` set, media URLs are built from it when read and never stored.
- An upload cap, `maxUploadBytes`, default 10 MB. Payload refuses to sign an upload URL for a larger file and signs
  `Content-Length` into the URL, so R2 refuses a different size. Uploads through the CMS itself are capped the same.
- Signed uploads only for the collection's `upload.mimeTypes`. Payload itself checks that list only for uploads through
  the CMS, so this package wraps the signing endpoint to check it for browser uploads too.
- `typescript.autoGenerate: false`. Outside production Payload otherwise spawns `payload generate:types` on every
  start, and in a test, a script or a directory without the config that process never exits. Run
  `payload generate:types` yourself, under a timeout (`timeout 120 pnpm payload generate:types`).
- The Lexical editor (`editor` overrides it), localization over `locales` (default `['en']`, the first is the default,
  with fallback), `typescript.declare: false`.
- `users` and `media` before the client's collections; `serverURL` and `csrf` from `CMS_URL` when set.

It refuses to start:

| When | Outside `NODE_ENV=development` or `test` | In development or test |
|---|---|---|
| `PAYLOAD_SECRET` unset | throws | a random secret for this process |
| `PAYLOAD_SECRET` shorter than 32 characters or a known template placeholder | throws | throws |
| any `R2_*` setting missing | throws, naming them | media on local disk |

There is no fallback secret. `next build` runs with `NODE_ENV=production` and loads the config, so a CI build that has
no real secrets sets throwaway values, such as `PAYLOAD_SECRET=$(openssl rand -hex 32)`.

## Users and roles

| Role | Admin panel | API key | Can |
|---|---|---|---|
| `admin` | yes | no | everything, including users and roles |
| `editor` | yes | no | content and media; sees and edits only their own user, never a role |
| `preview-reader` | no | yes | read drafts, for the marketing app's preview (`CMS_PREVIEW_API_KEY`) |
| `serviceRoles` you add, such as `stamp-submitter` | no | yes | what your collections' access gives the role |

Only the preview reader and service roles can hold an API key; saving an admin or editor with one fails.

Access helpers: `anyone`, `isAdmin`, `isStaff` (admin or editor), `allowRoles(...roles)`, `publishedOrPreview` (staff
and the preview reader read everything, everyone else only `_status: published`), `adminOnlyField`, `hasRole(user, ...roles)`.

A collection only staff may read, such as form submissions, takes `adminOrEditorOnly` (the same as `isStaff`) for
`read`. A collection a service key fills takes `submissionAccess('stamp-submitter')`: that role may only create, and
admins and editors read, update and delete. Nobody else reads it, over REST or GraphQL. Name the role in
`serviceRoles` and give the key's user that role.

### First admin

`/admin/create-first-user` would let whoever reaches a fresh database first become admin. `firstAdminGuard`, on the
users collection, refuses every user create while the collection is empty (403), unless the create carries the seed
context, which only server code can set. The release job runs the seed:

```ts
// apps/cms/src/seed.ts, run with `payload run src/seed.ts`
import { seedFirstAdmin } from '@pebbletech/cms';
import { getPayload } from 'payload';

import config from './payload.config';

const payload = await getPayload({ config });
const { created } = await seedFirstAdmin(payload); // FIRST_ADMIN_EMAIL, FIRST_ADMIN_PASSWORD (12+), only when users is empty
payload.logger.info(created ? 'first admin created' : 'users exist; seed skipped');
process.exit(0);
```

## Purge on publish

```ts
import { withRevalidateHooks, withGlobalRevalidateHooks } from '@pebbletech/cms';

export const Pages = withRevalidateHooks({ slug: 'pages', versions: { drafts: true }, fields: [/* … */] });
export const SiteSettings = withGlobalRevalidateHooks({ slug: 'site-settings', fields: [/* … */] });
```

After a change that publishes or unpublishes (any change when drafts are off) and after a delete, the hook posts a
signed purge to `${MARKETING_URL}/api/revalidate` with `REVALIDATE_SECRET`, and `x-vercel-protection-bypass` set to
`VERCEL_PROTECTION_BYPASS_MARKETING`. A draft save or autosave sends nothing. Default tags: `collection:<slug>`,
`doc:<slug>:<id>` and `doc:<slug>:<slug field>` for the new and previous version; a global sends `global:<slug>` and
`site`. A tag the receiver would refuse (empty, or over 256 characters, as a long slug makes) is left out and the rest
still purge. A failed purge is logged and does not fail the save. In development and test with nothing configured it is
skipped.

Wire format:

| Part | Value |
|---|---|
| Body | `{"tags":["…"],"ts":<unix seconds>}`, sent as the exact bytes signed |
| `x-pb-timestamp` | the same `ts` |
| `x-pb-signature` | HMAC-SHA256 hex over `${ts}.${rawBody}` |

The marketing route verifies it with `verifyPurgeRequest`, which refuses (401) a timestamp more than 5 minutes from
its clock either way, a signature that does not match (constant-time compare), and a body whose `ts` is not the signed
one; 400 for a body without a non-empty list of tags; 500 when the secret is unset.

```ts
// apps/marketing/src/routes/api.revalidate.ts
import { verifyPurgeRequest } from '@pebbletech/cms/site';

POST: async ({ request }) => {
  const result = await verifyPurgeRequest(request, { secret: process.env.REVALIDATE_SECRET });
  if (!result.ok) return new Response(result.reason, { status: result.status });
  await invalidateByTag(result.tags);
  return Response.json({ revalidated: true, tags: result.tags });
};
```

`collectionTag`, `docTag`, `globalTag` and `SITE_CACHE_TAG` are in `@pebbletech/cms/site` for the site's cache tags.

## Preview links

```ts
import { livePreviewLink, previewLink } from '@pebbletech/cms';

const path = (doc) => (doc.slug ? `/${doc.slug}` : null);
admin: { preview: previewLink({ path }), livePreview: { url: livePreviewLink({ path }) } }
```

Both give `${MARKETING_URL}/preview?path=<path>&exp=<unix seconds>&sig=<HMAC-SHA256 hex over ${path}.${exp}>` with
`PREVIEW_SECRET`, valid for an hour, or no link when either is unset. Only a site-relative path (one leading `/`) can
be signed. The site checks it with `verifyPreview(request.url, { secret: process.env.PREVIEW_SECRET })`, then reads
drafts with the preview reader's key. Previews stay behind Vercel Authentication: the link carries no bypass secret.

## Slack

```ts
import { formatStampNotice, notifySlackOnCreate } from '@pebbletech/cms';

hooks: {
  afterChange: [
    notifySlackOnCreate((doc) =>
      formatStampNotice({ stampUrl, note: doc.note, count, createdAt: doc.createdAt, albumUrl, removeUrl, stage })
    ),
  ],
}
```

`postToSlack(message)` posts text or Block Kit to `SLACK_WEBHOOK_URL`, sends nothing when it is unset (staging may post
nowhere), and refuses a URL that is not `https://hooks.slack.com/`. `notifySlackOnCreate` runs it on create only and
logs a failure instead of failing the create. Its message builder may be async, for a lookup such as a running count
before formatting; a throw or rejection is logged the same way. `formatStampNotice` is the stamp preset: one section that reads like a
postcard arriving, with the stamp image, the sender's note quoted (escaped, so it cannot make links or mentions),
`Stamp #N`, the time in Malaysia (`Asia/Kuala_Lumpur`), a link to the album and a small "remove" link to the stamp in
the admin. Any stage but `prod` is tagged, such as `[staging]`. An optional `details` object (`name`, `company`, `email`, `phone`,
`business`, `stuck`, `tried`, `links`) adds a labelled line for each field present, in the same block. Every visitor
field is made inert: `&`, `<` and `>` are escaped, so `<!channel>`, `<@U…>` and `<url|text>` stay text, and `@channel`,
`@here` and `@everyone` get a zero-width space. The note is cut at 500 characters, each detail at 300, and the whole
section at Slack's 3000.

## Media

`media` holds raster images only (AVIF, GIF, JPEG, PNG, WebP; no SVG, which can carry script) with required alt text.
Anyone reads; admins and editors upload, edit and delete. Other upload collections that store in R2 go in
`storageCollections`.
