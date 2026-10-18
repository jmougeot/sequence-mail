# Contributing

Thanks for helping out! Bug reports, fixes and small features are all welcome.

## Run it locally

```bash
npm install && cp .env.example .env && npm run dev   # http://localhost:3000
```

Before opening a pull request, run the type check:

```bash
npx tsc --noEmit
```

CI runs the same check plus a Docker smoke test.

## Pull requests

- Keep them small and focused: one fix or feature per PR.
- Don't commit secrets, `.env` files, databases or real contact data.
- LinkedIn automation limits must stay conservative: don't raise the default limits in a PR. Make new limits configurable instead.
- Template syntax: `{{variable}}` and `{{if variable}}…{{else}}…{{end}}`.

## How PRs are merged

This repository is a mirror of the maintainer's upstream tree, regenerated on every release, so pull requests are not merged with GitHub's merge button. A PR is reviewed here, then applied to the upstream tree with you as the commit author, published back to this repository, and closed with a link to the resulting commit. Your authorship is kept in the history.

## Security

Please report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
