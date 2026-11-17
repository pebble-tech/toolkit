---
'@pebbletech/infra': minor
---

`VercelProject` stops a pull request's preview from becoming a new project's production deployment. Vercel makes a
project's first deployment production when it names no target, as a preview deploy does. The `shared` stack now
deploys a static placeholder page shipped in the package (`placeholder/index.html`, no build) to the project, also
naming no target: on a new project it is the first deployment, so it becomes production until the first release
replaces it; on a project that already has a production deployment it is one more preview, and production is
untouched. It is created once (its inputs are ignored afterwards), and protected and retained like every `shared`
child. A product does nothing; a test that lists `shared`'s resources sees `vercel:index/deployment:Deployment
<name>-placeholder`.
