# Contributing

Thanks for helping. A few things before you open a pull request.

## Before you start

- Setup, running and testing are in the [README](README.md#development).
- Read the ground rules there, and `CLAUDE.md` if you are changing anything in
  `src/scan/`. Above all: the app never writes to a card, and a file it cannot
  confirm is never reported as safe.
- For anything larger than a small fix, open an issue first so we can agree on
  the approach.

## Pull requests

- `npm test` and `npm run typecheck` pass.
- New behaviour comes with a test.
- If the change is something a user would notice, say so in the description,
  so the [website docs](https://can-i-format-site.vercel.app/docs) can be
  updated to match.

## Licensing your contribution

Can I Format is licensed under the GNU General Public License, version 3
(GPL-3.0-only). By submitting a contribution, you agree that:

1. your contribution is licensed under GPL-3.0-only, and
2. you also grant Filip Hasson a perpetual, worldwide, non-exclusive,
   royalty-free licence to use, modify, and distribute your contribution,
   and to relicense it under other terms, including commercial ones.

The second point lets the project be offered under other licences in the
future without having to track down every contributor. You keep the copyright
to your contribution, and the GPL version remains available to everyone.

You also confirm that you wrote the contribution, or otherwise have the right
to submit it under these terms.
