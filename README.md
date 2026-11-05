# xrnmail

Your Gmail, delivered in batches. Mail lands a few times a day instead of whenever someone sends it,
and the people who matter come straight through.

**It only reads for now.** The mailbox opens read-only, so nothing here can change, send, or delete
mail. "Reply in Gmail" opens the thread in your browser.

## What it does

- **Batches:** new inbox mail waits for the next slot (09:00, 13:00, 17:00 by default). Waiting mail
  stays out of the list, threads and search until then.
- **Straight through:** addresses or whole @domains that skip the wait.
- **Deliver now:** works a set number of times a day, after a 30-second wait.
- **Search:** finds Vietnamese without its marks, so `lich thi` finds "Lịch thi".
- **Several accounts** in one inbox, with Gmail's threads and labels.
- **Safe with hostile mail:** no scripts, and no remote images until you ask. See
  [docs/design.md](docs/design.md).
- **xrnhub:** optional, and gets counts only.

## Using it

Each account needs a Gmail app password, which needs 2-Step Verification on. Make one at
<https://myaccount.google.com/apppasswords>, then paste it into xrnmail. It's checked straight away
and kept in your system keyring.

Keys: `j` and `k` move, `/` searches, `Esc` closes.

## Building

```sh
npm install
npm run build && npm start     # run it
npm run app:install            # build an AppImage and add it to the launcher (Linux)
```

## Tests

```sh
npm test            # logic, against a fake Gmail over a real socket
npm run test:e2e    # the built app, including a hostile email
npm run typecheck
```

`SHOTS=<folder> npx playwright test shots` takes pictures of the app with made-up mail.
