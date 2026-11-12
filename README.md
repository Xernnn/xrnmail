<p align="center">
  <img src="resources/icon.svg" width="72" height="72" alt="">
</p>

<h1 align="center">xrnmail</h1>

All your mail accounts in one place, delivered in batches. Gmail, Outlook, Yahoo, iCloud or any IMAP
server sit side by side, and mail lands a few times a day instead of whenever someone sends it, with
the people who matter coming straight through.

It's a full mail client: write, reply, archive, delete, snooze. Your mail stays on your laptop and with
your mail service, with no server of ours in between. Everything clever happens on your laptop.

It looks and works like Edison Mail for Mac, in its own code: the same window (sidebar, a title and
search across the top, the list, the reader with Reply and Forward at its foot), the same rows and
quick actions, the same sections in Settings and the same keys. What xrnmail adds on top is listed
under [Where it differs from Edison Mail](#where-it-differs-from-edison-mail).

## What it does

- **Every account at once:** one inbox across services, or each on its own, with a colour for each.
  Gmail keeps its labels and threads; other services get their folders, and threads worked out from
  the messages. Aliases work too, and a reply goes out from the address the mail came to.
- **Batches:** new inbox mail waits for the next slot (09:00, 13:00, 17:00 by default). Waiting mail
  stays out of the list, threads and search until then.
- **Straight through:** addresses or whole @domains that skip the wait, set in Settings or from a
  message's menu.
- **Deliver now:** works a set number of times a day, after a 30-second wait.
- **Writing:** reply, reply all, forward with attachments, formatting, signatures, templates, drafts
  that survive a restart, and addresses suggested from your mail. Replying starts from the buttons at
  the foot of a thread, in the composer.
- **Undo send and send later:** a message waits 10 seconds by default before it leaves.
- **Sorting mail:** archive, delete, spam, flag, labels or folders, read and unread, all kept in step
  with the server, one thread or many at once, with Undo. It keeps working offline and catches up.
- **Trash and Spam:** read them, restore from them, or delete for good.
- **Pinned:** pin a thread from its menu, a row's menu, or by dropping it on Pinned, and find it
  there afterwards. A pin is this laptop's own note: the mail service isn't told, and flags stay free
  for what they mean there.
- **Recently Seen:** the threads you've opened, the last one first, wherever they are now: archived
  ones stay, and what's in Trash or Spam waits there. It keeps the last hundred, on this laptop only,
  and its right-click menu clears it. Reading from the list itself leaves its order as it is.
- **Focused and Other:** people on one side, and everything sent to everyone on the other. Say which
  side a sender belongs on and it stays there.
- **Assistant:** packages with their tracking, travel, bills and receipts, and events, found in your
  mail on this laptop. Calendar invitations can be answered from the message.
- **Subscriptions:** everyone mailing you in bulk, with Unsubscribe, Add to Summary and Delete all next
  to each, and the ones left behind and the ones in the Summary on sides of their own.
- **The Subscription Summary:** chosen senders' new mail waits, and lands together, daily or weekly at
  the time you pick (the first sender added asks; Settings, Summary changes it or turns it off).
  Senders go in from Subscriptions or a message's menu. When it lands, one notice says so, and the top
  of the inbox has one entry for it until it's read. Its mail is under Summary in the sidebar, each
  Summary under its own heading with Delete all, and stays out of the inbox and its counts.
- **Sender warnings:** forged mail, lookalike addresses, a name showing a different address, replies
  going somewhere else. It warns; it never vouches.
- **Snooze:** a thread comes back when you say, or when someone replies.
- **Clearing out:** one-click unsubscribe, and blocking a sender or a whole @domain.
- **Muted senders:** their mail arrives as usual and nothing announces it. From a message's menu, or
  Settings, Notifications.
- **Tracker blocking:** invisible images and known open-trackers are removed, even after Show images.
- **Attachments:** fetched when you ask, saved or opened. Anything that can run is saved, never opened.
  A row in the list shows its thread's files as small cards, unless Appearance says not to.
- **Windows of their own:** the last button over a thread opens it in its own window, and the
  composer's does the same for what you're writing. A thread's window follows it into Trash and back,
  and what's typed in a composer is kept when its window is closed.
- **Search:** finds Vietnamese without its marks, so `lich thi` finds "Lịch thi". Also `from:`,
  `subject:`, `to:`, `after:2026-01-31`, `before:`, `has:attachment`, `is:unread`, `is:read`, `is:flagged` and `in:inbox`.
- **Safe with hostile mail:** no scripts, and no remote images until you ask. See
  [docs/design.md](docs/design.md).
- **Quoted text folded away:** a reply shows what's new, with `•••` for what it quotes, and previews
  in the list do the same.
- **Comfortable to live in:** four quick actions on a row under the pointer and a short and a long swipe
  each way (all of them yours to choose in Settings, Customize Actions), a bar of actions under a
  selection, drag to the sidebar, right-click menus (on the sidebar: mark all as read, and Edit Menu to
  choose which of its entries show and in what order, each account's own labels or folders among them,
  with New Label or New Folder to make one on the server), recipient chips, side-by-side or
  one-at-a-time reading, one to four lines of preview, and Settings you can search.
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

Press `?` for the keys. The set is Edison Mail's, with Command read as Ctrl: `c` or `d` writes, `r` or
Ctrl+R replies, Backspace takes a thread out of view (archives it), Shift+Backspace deletes, Ctrl+S
flags, Shift+I marks read. The keys xrnmail had before still work beside them (`j` and `k` move, `e`
archives, `#` deletes, `z` undoes). Settings, Shortcuts has the other sets Edison offers: Gmail's
(xrnmail's old keys alone, where Delete deletes), Apple Mail's, Outlook's and Inbox's, each from its
maker's list with Command read as Ctrl. Any action's key can be changed there: press Change, then the
new key. A key another action has is offered to take over, and a change can go back to the set's own.
Ctrl+N, Ctrl+F, Ctrl+Enter and F5 are the menu's and the composer's in every set.

To have mail links open here, set it as your mail app after installing:
`xdg-mime default xrnmail.desktop x-scheme-handler/mailto`.

## Where it differs from Edison Mail

Kept from xrnmail, where Edison has nothing: batches and straight-through senders, the delivery line
over the list, Snoozed and Attachments in the sidebar, search without Vietnamese marks, sender
warnings, xrnhub, and the one-thing-at-a-time layout.

Not here, though Edison has them:

- In Subscriptions, picking several senders at once to add to the Summary, and a page for each sender
  with how much they send and how much of it gets opened.
- Settings' Labels, Back up & Sync and Privacy pages, which Edison's pictures name but don't open.
  Back up & Sync would need a server of Edison's.

Done differently:

- Settings and the sync status sit at the foot of the sidebar, because Linux hides the menu bar
  Edison keeps its Preferences in. Appearance has an Edit Menu button beside the right-click one.
- A pinned thread stays where it is in its list and is gathered under Pinned. Whether Edison also
  lifts pinned mail to the top of a list isn't shown anywhere, so it isn't done.
- The composer starts as a panel in the window and moves to a window of its own when asked; Edison's
  is always a window.
- A thread's own window stays open when the thread is archived or deleted, showing it where it went
  with Undo still there, and closes when it's marked unread or gone for good.
- Muted senders are a list of addresses or @domains typed in or added from a message, as blocked
  senders are; Edison picks them from contacts.
- How the Summary and batches sit together is xrnmail's, since Edison has no batches. A sender in the
  Summary waits for its time, not the next batch, and does with batches off; Deliver now is for the
  batch and leaves it waiting. Letting a sender straight through takes them out of it, and adding one
  to it takes them off that list. Its mail stays in your service's inbox: only this laptop shows it
  apart.
- The Inbox set is from Inbox's own Shift+? list, as people who used it wrote it down, since Google's
  help page only ever said to press Shift+?. Apple's page leaves out deleting, flagging and searching,
  so those are from Mail's menus. Outlook's is Outlook for Mac's.
- In Edit Menu a label moves among the ones beside it, taking what's inside it along, and hiding one
  hides what's inside it. An account's All Mail, Sent and the rest stay where they are. Making a label
  or folder goes to the server there and then, so it needs a connection, where other changes wait.
- A changed key is one key for its action, in place of all the set's keys for it.
- Recently Seen is a reading of its name. Edison's sidebar has it, after All Sent, in every picture,
  and nothing it publishes says what it lists. Here it's a history of the threads opened.

## What it doesn't do yet

- The tests use fake servers, and it has hardly been used with real accounts yet. Expect surprises from
  real ones, Outlook's sign-in most of all.
- Drafts stay on this laptop, and don't appear in your service's Drafts.
- No mail rules, translation, or written summaries of what mail says, and nothing is built for Windows or
  macOS or for phones.
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
