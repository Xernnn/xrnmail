# How xrnmail works

## Shape

```
server (IMAP) ──> source.ts ──> sync.ts ──> store.ts (SQLite) ──> service.ts ──> IPC ──> page
                                               batches.ts decides when a message may be seen
                                               assistant.ts sorts it and finds what's in it

page ──> service.ts ──> store.ts, at once ──> pending queue ──> writer.ts ──> server (IMAP)
                   └──> drafts ──> sender.ts ──> server (SMTP)
```

`service.ts` holds everything the app does, with the clock and the network passed in, so whole days
of batches run in tests. `index.ts` only connects it to Electron.

## Accounts and services

Gmail and everything else disagree about what a message is. Gmail keeps one copy in All Mail with labels
saying where it shows. Everywhere else a message lives in one folder, and moving it gives it a new UID.
The app is built around the second, with Gmail as the case where nearly everything is in one box.

A row is `(account, box, uid)`. `box` is `@role` for special folders (`@all`, `@inbox`, `@sent`,
`@archive`, `@trash`, `@junk`), so a renamed or translated folder stays the same box, and the path for
ordinary ones. `labels` holds what the message would have on Gmail, worked out from the box elsewhere,
so most code doesn't need to know which it's looking at. `bin` says Trash or Spam, and ordinary reads
filter on `bin = 0`.

- Which kind a server is comes from what it says it can do (`X-GM-EXT-1`), not from what it's called, so
  a Workspace account on a company's own domain is treated as Gmail. `AccountView.labels` tells the page
  whether to offer labels or a Move menu.
- Gmail reads All Mail, Trash and Spam. Other servers read every folder except All Mail, Drafts and
  ones that only collect what's elsewhere, and what some servers show that isn't mail.
- Threads on other servers are the hash of the first Message-ID in `References`, so a thread can span
  folders. `Store.thread` shows a message once when it's in two.
- Servers without CONDSTORE can't say what changed, so flags are read again each pass.
- Connections are `tls` or `starttls`, and STARTTLS is required rather than tried, so a server that stops
  offering it never gets the password. Plain text isn't accepted from the form. The fake servers use a
  value that only code can set.
- Outlook has no passwords, so it signs in with the device-code flow and XOAUTH2. The Application ID is
  the person's own: reusing another mail app's would be pretending to be that app. The refresh token
  goes in the keyring like a password, and access tokens stay in memory. Only Microsoft refusing a
  renewal outright asks to sign in again. Busy, failing and rate-limited answers (5xx, 429,
  `temporarily_unavailable`) are waited out like a lost connection, and mail due to go stays queued.

## Reading and changing are kept apart

Syncing can't change anything. `MailSource` has no method that does, `ImapSource` opens every folder with
`EXAMINE` and refuses to go on if the server didn't open it read-only, and fetches use `BODY.PEEK` so
mail doesn't get marked as read. Tests record every command the fake servers receive and check that a
sync sends none that could write.

Changes go through `MailWriter`, which is small on purpose and runs on its own connection, only for
something the person did. imapflow answers `false` rather than throwing when a command fails, so
`ImapWriter` checks every answer: an unchecked one would report a change the server refused.

## Changes

An action applies to `store.ts` at once, so the app never waits on the network, and joins the `pending`
table. That's what lets it survive being offline or a restart. Anything that takes mail out of view waits
six seconds for Undo before setting off; everything else goes straight away.

- Only mail that can be seen is touched. A held reply in the same thread is left alone.
- `MailService.inLane` runs one thing at a time per account. A sync reading the server while a change is
  on its way could otherwise put back what was just archived. Messages with a change still waiting are
  skipped when applying what the server says, and the next sync picks up the true state.
- The queue holds row ids, not UIDs, and the folder and UID are looked up as each change goes out. A move
  renumbers a message, so a star queued behind an archive would otherwise reach nothing, or the wrong
  message. After a move the row follows it using the server's `COPYUID` answer. Without one, or when
  it's gone somewhere not read here, the row is dropped and the next sync finds it again.
- On folder servers an action on a thread touches the part of it that makes sense: archive takes what's
  in the inbox, not your own copy in Sent. Delete for good only ever reaches mail already in a bin.
- A lost connection loses nothing: the change goes again later, in order. A refusal is retried twice,
  then the message is put back as it was and the sidebar says so.
- Moves use `UID MOVE` where the server has it, and copy then delete where it doesn't. A service with no
  Archive or Trash folder gets one the first time it's needed.
- Delete and spam change the row's `bin` at once, which is what makes Undo possible. `hidden` is only for
  mail being deleted for good, and Gmail's own unsent drafts. Every read leaves out hidden rows, as it
  does held ones.
- Snoozing is kept here only (`snoozes`), and Gmail isn't told. A thread is away while `until` is ahead
  and nothing newer has landed in it, so a reply wakes it. It sorts by `until` once it's back.

## Sending

Mail goes through the service's SMTP server with the same sign-in. Gmail and Outlook file their own copy
in Sent; for the rest it's added afterwards, unless the server turns out to have done it, which is
checked by Message-ID. Failing to file a copy leaves a note and is never a reason to send again. A draft
has a state: `draft`, `queued`, `sending` or `failed`. Send only queues it with a `send_at`, which
is all Undo and "send later" are. `tick()` sends what's due.

**A message is never sent twice on a guess.** A duplicate to a real person is worse than asking.

- `SmtpSender` connects and signs in as its own step first, since that's the one failure that proves
  nothing left. nodemailer reports a connection lost after the message was handed over the same way as
  one that never opened, so its error codes can't be used for this. Only that first step is retried.
- Any later failure ends in `failed`, with "check Sent". The state is written as `sending` before the
  attempt, so a crash comes back the same way instead of as a retry.
- **Nothing goes that the person took back.** Until a draft is marked `sending` it can be called back,
  changed or thrown away, and sending the ones due before it can take a while. So `sending` is only
  written if the draft is still queued and due at that moment, and what goes is the draft as it is
  then, never as it was when the round began.

Drafts stay on this laptop. Attachments are copied into the profile when chosen, so a message scheduled
for later doesn't depend on where the file was.

## Sync

Every three minutes, and on waking, each account connects, syncs and logs out. Batching means nothing
depends on being fast, so these passes are what the app relies on; watching the inbox, below, only
brings the next one forward.

A pass goes through each folder in turn, inbox first. For each it fetches what's missing, newest first,
then applies label and flag changes, then forgets what's gone. A folder the server has stopped listing
is forgotten too, and an ordinary folder that refuses to open or to be searched is skipped rather than
stopping the rest.

- What's gone is whatever the folder's search didn't return, so a search that's turned down or cut off
  has to fail, and forgets nothing. imapflow answers those with `false` or nothing at all, and taking
  either for an empty folder would forget every message in it.
- Removing an account stops a pass that's under way at its next folder, batch or message, and anything
  it kept goes with the account. Otherwise a first sync carried on filling the shared inbox with mail
  from an account that was no longer there, and nothing would ever take it out.
- `UIDVALIDITY` changing means every stored UID in that folder now points at the wrong message, so that
  folder starts over, keeping the moment holding began.
- IMAP `SINCE` compares dates in the server's zone, so mail within two days of the window's edge is
  neither taken for deleted nor refetched.
- A message over 4 MB is cut at that length, which usually loses only attachments, and says so.
- Attachments are listed but not kept. They're fetched whole when asked for, and read with `BODY.PEEK`.
- Gmail's own unsent drafts are in All Mail too. They're kept hidden, so a thread doesn't show them.

### Watching the inbox

One more connection per account sits on `INBOX`, opened read-only, and waits in IDLE. It reads nothing:
when the server says something landed, it asks for an ordinary sync, so there's still one way into the
store and the batches apply as usual. If the sync is already running it's asked to go again afterwards,
because what landed may have missed it. A lost connection is retried after a minute, and the
three-minute passes carry on regardless, so watching can fail without anything being missed.

There's one watch per account, counted from when it starts signing in. Waking from sleep replaces
them all, and an old one finishing its goodbye only ever clears its own place, so a wake can't leave a
connection running that nothing will close. Gmail allows fifteen at once.

## Staying open

Closing the window hides it while the tray exists and "Keep running in the tray" is on, so
notifications and mail set for later still work. Without a tray there would be no way back, so the app
quits instead. Quitting properly runs `finishUp`: mail only waiting out Undo goes now, as do pending
changes, within eight seconds. Mail scheduled for later stays scheduled; its time hasn't come, and
sending early would be worse than sending late.

## The Assistant

`assistant.ts` decides Focused or Other, and finds parcels, travel, bills and events. It runs as mail is
stored, on this laptop, and sees only that message. The services this replaces do it on their servers by
reading your mail, which is the part not copied.

Facts senders put there on purpose come first: calendar invitations, and the schema.org data airlines,
hotels and shops include for inboxes to read. Patterns come after, in English and Vietnamese, kept strict
because a wrong entry is worse than a missing one, and they aren't applied to bulk mail at all.

A stranger wrote all of it, so it's held to the same standard as the mail:

- The data is parsed as JSON and never run. Everything found is shown as text.
- It can't supply a link. "Track" goes to an address built here from the carrier and a number that
  must be plain letters and digits.
- It can't stall the app. Sorting runs in the main process during sync, so patterns over a message are
  bounded and the awkward parsing is done by hand. A pattern that backtracks over two megabytes of a
  stranger's HTML would hang everything, and `tests/assistant.test.ts` keeps the messages that would.
- An invitation's answer goes to its organizer only if that's one plain address, and it's a draft like
  any other, so it waits out Undo and goes through the same door. Nothing goes out unless a button is
  pressed.

Sender warnings only ever warn. They read the top `Authentication-Results` line, which the receiving
server wrote, and a pass is never shown, because lower lines are the sender's own work and on a server
that adds no line of its own the top one is too.

## Batches

`batches.ts` is pure, and every read in `store.ts` takes `now`, so a waiting message simply isn't
there: not in the list, a thread, search, label counts, a snippet, the Assistant or subscriptions.

The clock for everything is when the server received the message. The `Date` header isn't used, since a
sender can write what they like there.

- Only new inbox mail waits. Mail from before the account was added, your own, and what a filter
  filed away are there at once. That includes Spam and Trash, which also count for nothing in the
  "waiting" figure, in search, or in contacts.
- Mail that arrived while the laptop was off is measured from when it arrived, so it's simply there.
- Changing the times moves waiting mail to the next slot after now, so a change can't deliver
  anything early. Turning batches off, or adding a sender to the straight-through list, does.

## Hostile mail

A stranger writes every email, and the window holds a bridge to all of them. So there are several
walls, and `e2e/mail.spec.ts` sends a hostile message through them.

1. DOMPurify, without forms, frames, objects, SVG or `<base>`.
2. A frame with `sandbox` and no `allow-scripts`. It has `allow-same-origin` only so the page can size
   it and catch clicks; with no scripts inside, nothing can use that.
3. A CSP in the frame with no network, widened to images only when asked.
4. The main process cancels every request from the page, whatever the CSP says, except images while
   "Show images" is on. That resets on leaving the thread. Images can be set to always load, or for
   one sender at a time, but that only presses the same button for you: it goes through the same switch
   in the main process. The default is to ask.
5. Images that exist to report an open (invisible ones, and known tracking services) lose their `src`
   while DOMPurify cleans the message, so "Show images" can't set one off and a reply can't pass one on.
   It's done there, on the tree, because taking clean HTML apart and rebuilding it can undo the cleaning.
5. Links go through a scheme allowlist before reaching the system, and hovering shows where one goes.
6. No navigation, new windows, downloads, permissions or webviews, and the bridge answers only the
   app's own page.

Packaged builds also drop Electron's Node and debugging entry points (`electron-builder.yml`).

Writing and acting on mail gave strangers new things to aim at, so:

- **The editor holds only what's typed.** A quoted message would otherwise put a stranger's HTML in the
  app's own page, next to the bridge. The quote stays out of the editor, is sanitised on its way into
  the draft, and shows only in a sandboxed frame. Pasting is as plain text, for the same reason.
- **Files enter a draft only through the system's picker, or as bytes that were dropped or pasted.** The
  page never names a path, so a compromised page can't attach `~/.ssh/id_ed25519` and send it. Being able
  to send mail is the new thing a compromised page could do, which is why this line is held so firmly.
- **Attachments are saved, or opened only if they can't run.** `canOpenDirectly` refuses scripts,
  programs, `.desktop` files and anything that renders as a page. File names are cleaned before they're
  suggested, so `../../.ssh/authorized_keys` can't climb out.
- **Unsubscribing makes one fixed request.** The address comes from a stranger's header, so the app sends
  only the POST that RFC 8058 defines, without credentials or redirects, to https on a public name, and
  only when the button is pressed. Anything else opens in the browser. A mail-only sender gets a draft
  to read, never a message sent behind your back.
- **`mailto:` links only fill in a draft.** Whatever they ask for, including a Bcc, is on show first.
- **Blocking** matches the `From` address, which a sender writes, so it's a filter for nuisances and not
  a security wall. Mail it catches goes to Trash, where it can still be found.

## Secrets

App passwords are encrypted by the system keyring through `safeStorage`. Linux's `basic_text` fallback
is a key built into every Chromium, so it counts as no keyring and adding an account is refused. The
page never receives a password.

A password that's kept but can't be read, because the keyring wasn't open when the app first asked,
isn't gone. Chromium keeps that first answer until the app quits, so the sidebar asks to unlock the
keyring and restart, and mail due to go waits. Only a password that isn't kept at all, or that an open
keyring can't decrypt, asks for the account to be added again.

Mail itself sits in `mail.sqlite` in the app's profile, readable only by this user, and isn't
encrypted. Full-disk encryption covers that.

## Storage

`MIGRATIONS` in `store.ts` lists every change to the file in order, and `PRAGMA user_version` records how
far a file has come, so an update upgrades whatever's there. Shipped entries are never edited: a change
is a new entry. The `search` table is kept in step by hand, with no triggers.

## xrnhub

Optional. `POST /api/events` with Basic auth over https (or to this machine), and never following a
redirect, which would carry the password elsewhere. Only counts and times are sent:

```json
{"app": "xrnmail", "kind": "state.held", "at": 1790000000000, "value": 3,
 "detail": {"held": 3, "nextBatch": 1790003600000}}
```

`batch` and `early` are things that happened, and appear on the hub's timeline. `state.*` feeds its
card. A hub that's down changes nothing here.

## Reading what's quoted

Most of a reply is what it quotes. `splitQuoted` finds where a plain message starts quoting, walking
lines and testing short slices so a stranger's text can't stall it, and previews and the plain-text
body share it. HTML is different: taking clean HTML apart and putting it back together is how sanitised
markup gets turned hostile again, so nothing is removed. A class on the frame's root hides the known
quote markers with CSS, and the `•••` toggles that class. A forward keeps everything, because the
quote is what was sent.
