# xrnmail

All your mail accounts in one place, delivered in batches. Gmail, Outlook, Yahoo, iCloud or any IMAP
server sit side by side, and mail lands a few times a day instead of whenever someone sends it, with
the people who matter coming straight through.

It's a full mail client: write, reply, archive, delete, snooze. Your mail stays on your laptop and with
your mail service, with no server of ours in between. Everything clever happens on your laptop.

## What it does

- **Every account at once:** one inbox across services, or each on its own, with a colour for each.
  Gmail keeps its labels and threads; other services get their folders, and threads worked out from
  the messages. Aliases work too, and a reply goes out from the address the mail came to.
- **Batches:** new inbox mail waits for the next slot (09:00, 13:00, 17:00 by default). Waiting mail
  stays out of the list, threads and search until then.
- **Straight through:** addresses or whole @domains that skip the wait.
- **Deliver now:** works a set number of times a day, after a 30-second wait.
- **Writing:** reply, reply all, forward with attachments, formatting, signatures, templates, drafts
  that survive a restart, and addresses suggested from your mail.
- **Undo send and send later:** a message waits 10 seconds by default before it leaves.
- **Sorting mail:** archive, delete, spam, star, labels or folders, read and unread, all kept in step
  with the server, one thread or many at once, with Undo. It keeps working offline and catches up.
- **Trash and Spam:** read them, restore from them, or delete for good.
- **Focused and Other:** people on one side, and everything sent to everyone on the other. Say which
  side a sender belongs on and it stays there.
- **Assistant:** packages with their tracking, travel, bills and receipts, and events, found in your
  mail on this laptop. Calendar invitations can be answered from the message.
- **Subscriptions:** everyone mailing you in bulk, with Unsubscribe and Delete all next to each.
- **Sender warnings:** forged mail, lookalike addresses, a name showing a different address, replies
  going somewhere else. It warns; it never vouches.
- **Snooze:** a thread comes back when you say, or when someone replies.
- **Clearing out:** one-click unsubscribe, and blocking a sender or a whole @domain.
- **Tracker blocking:** invisible images and known open-trackers are removed, even after Show images.
- **Attachments:** fetched when you ask, saved or opened. Anything that can run is saved, never opened.
- **Search:** finds Vietnamese without its marks, so `lich thi` finds "Lịch thi". Also `from:`,
  `subject:`, `to:`, `after:2026-01-31`, `before:`, `has:attachment`, `is:unread`, `is:read`, `is:starred` and `in:inbox`.
- **Safe with hostile mail:** no scripts, and no remote images until you ask. See
  [docs/design.md](docs/design.md).
- **Quoted text folded away:** a reply shows what's new, with `•••` for what it quotes, and previews
  in the list do the same.
- **Comfortable to live in:** swipe, drag to the sidebar, right-click menus, recipient chips, side-by-side
  or one-at-a-time reading, and Settings you can search.
- **Stays with you:** new mail shows as it lands, the tray shows what's unread, and closing the window
  keeps it running. Spell check knows your language, plus English and Vietnamese.
- **Light or dark**, or whatever the system says.
- **xrnhub:** optional, and gets counts only.

## Using it

Enter your address and xrnmail works out the service, from the address or the domain's public mail
records. Reading and sending are both checked before anything is kept, and passwords go in your system
keyring.

- **Gmail, Yahoo, iCloud, AOL, Fastmail, Zoho:** an app password from the service. The button in the form
  goes to the right page.
- **Outlook and Microsoft 365:** Microsoft doesn't accept passwords any more, and only lets a registered
  app sign in. Registering one is free and takes a few minutes in
  [Microsoft Entra](https://entra.microsoft.com): allow personal and work accounts, turn on public client
  flows, add the delegated permissions `IMAP.AccessAsUser.All` and `SMTP.Send`, and paste its Application
  ID into xrnmail. You then sign in on Microsoft's own page with a code.
- **Anything else:** your password and the server's details. Only encrypted connections are accepted.

Press `?` for the keys. They follow Gmail's: `j` and `k` move, `e` archives, `#` deletes, `r` replies,
`c` writes, `z` undoes.

To have mail links open here, set it as your mail app after installing:
`xdg-mime default xrnmail.desktop x-scheme-handler/mailto`.

## What it doesn't do yet

- The tests use fake servers, and it has hardly been used with real accounts yet. Expect surprises from
  real ones, Outlook's sign-in most of all.
- Drafts stay on this laptop, and don't appear in your service's Drafts.
- No mail rules, translation, or summaries, no custom shortcut sets, and nothing is built for Windows
  or macOS or for phones.
- Senders show as coloured initials, never photos or company logos, because fetching one would tell
  someone who writes to you.
- The Assistant reads machine-readable facts first, then strict patterns in English and Vietnamese. It
  will miss things: a wrong entry is worse than a missing one.
- Search covers the mail kept on this laptop (90 days by default, up to three years in Settings).
- A scheduled message goes out when the app is running at or after its time. Closing the window keeps
  it running; Quit doesn't, though anything only waiting out Undo goes before it closes.

## Building

```sh
npm install
npm run build && npm start     # run it
npm run app:install            # build an AppImage and add it to the launcher (Linux)
```

## Tests

```sh
npm test            # logic, against fake IMAP and SMTP servers over real sockets
npm run test:e2e    # the built app, including a hostile email
npm run typecheck
```

`SHOTS=<folder> npx playwright test shots` takes pictures of the app with made-up mail.
